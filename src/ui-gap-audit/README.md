# UI Gap Audit

第一轮审计：**当前系统真实有什么** vs **目标 UI（LibTV）是什么形状**，
以及由此推出的**最小正确 UI 改动**。

日期 2026-08-16 · Commit `18fa281` · 分支 `feat/wfm1-batch-c`
验收环境：真实 Connected Project `照见未明rev2`（AGENTS.md 第 20 条），
**不是** demo seed。

## 读的顺序

| 文件 | 回答什么 |
| --- | --- |
| [reports/current-capabilities.md](reports/current-capabilities.md) | 后端到底有什么？前端实际调了什么？普通用户现在能做什么？哪些能力被藏起来了？ |
| [reports/target-workflow-walkthrough.md](reports/target-workflow-walkthrough.md) | **在 LibTV 上做出一条视频，实际需要哪些步骤**（逐个 tab / 节点点进去走查），同一条链在我们这里是什么样 |
| [reports/ui-gap-analysis.md](reports/ui-gap-analysis.md) | 18 条 Gap，逐条：现状 / 目标 / 差在哪 / 为什么重要 / 系统支不支持 / 要改什么 / 优先级 |
| [reports/feature-matrix.md](reports/feature-matrix.md) | 能力 × 后端 × 前端接线 × 当前 UI × 目标 UI × 差距 × 动作 |
| [reports/user-journey-matrix.md](reports/user-journey-matrix.md) | **从进项目到出片，到底哪里断了** |
| [manifests/screenshots.md](manifests/screenshots.md) | 全部截图登记（C-xxx 当前 / T-xxx 目标），含复现命令 |

## 截图

`screenshots/{current,target,comparison,archive}/`。

**像素不进 Git**（见仓库根 `.gitignore`）：`current/` 拍的是用户自己的创作项目，
`target/` 拍的是另一家公司的产品界面 —— 与 `_agent-tools/` 同一条理由
（AGENTS.md 第 23 条）。**清单、报告和抓图脚本进 Git**，所以审计可从仓库复现：

```bash
# 1. 起后端（真实项目）
PYTHONIOENCODING=utf-8 .venv/Scripts/python mockups/motv-workspace/server.py \
    --account-root "D:/02_Work/04_video-work/MotvProjects" --port 8791
# 2. 抓当前 UI
PYTHONIOENCODING=utf-8 .venv/Scripts/python src/ui-gap-audit/tools/capture_current.py \
    --port 8791 --project 照见未明rev2
```

目标 UI 需要用户自己的登录态（凭据从不经过 agent）：用一个有界面的浏览器登录一次，
把会话存到会话临时目录，再复用它抓图。

## 目标 UI 的探索边界（如实记录）

逐个 tab / 面板 / 节点点进去走查了，并且走完了一条**别人已经跑完的完整工作流**
（精选画布「查看创作过程」，只读，零花费）。

**没做的**：实际按下任何一个「提交」。图片 ⚡18 / 视频 ⚡135 / 音频 ⚡1，
按下去花的是用户真金白银 —— CLAUDE.md 里付费是唯一必须先问的事。
因此「生成中 / 生成失败 / 生成完成」这三个运行时状态**没有实拍**，
智能剪辑与逐帧拉片的实际产出同理。清单见
[manifests/screenshots.md](manifests/screenshots.md) 末尾。

## 本轮的三条结论

1. **后端不是短板。** 19 个只读查询 Studio 只用 3 个；6 个 Gateway 命令 Studio 只有 2 个；
   核心库 20 个子包只有 4 个被前端 import。
2. **当前 UI 最大的问题是诚实性与暴露度，不是视觉。** 顶栏把后端明确标记为
   `unavailable` 的预算渲染成 `¥0`；存储页报「媒体不可用 0」而实际有 2 个文件已丢失；
   ADR-0066 冻结的十一页有五页没有入口、一页完全不可达。
3. **我们缺的不是能力，是「一条看得见的流水线」。** 目标产品把
   **分镜表 → 资产缺口 → 提示词 → 批量生成** 串成一条带进度的向导
   （`① 确认镜头 9个已就绪 → ② 准备资产 0/6、还差 6 个 → ③ 合成提示词 0/9`），
   而且第 ② 步的「6 个」是**从分镜表里高亮的实体自动推导出来的**。
   我们把这四件事拆在四个页面，**而且我们自己那条一模一样的三步向导
   （`ui/wizard.js`）唯一入口挂在已下线的节点画布上，等于不存在。**

   要学的机制：**分镜是表不是卡**（38 镜的景别/运镜全空就是卡片式逼的）、
   **实体链接 → 资产缺口**、**制作面 ⇄ 审阅面双视图**（`工作流` ⇄ `故事板`）、
   **一次生成 = 一张卡**（含可选模型与报价）、**「引用该节点生成」通用链式**、
   **Skill 一级页面 + Agent 常驻会话**（`/skill` + `@节点/分组/模型`）、**URL 即状态**。

   **不要学的**：把跨集的东西（角色/场景地/关系/世界规则/分集规划/全季进度）
   也塞进画布 —— LibTV 没有跨集层，它的「天使资产」组只是画布内的一个分组，
   换一块画布就得再复制一份。那一层是我们相对它最实的优势。

   > **两处更正**（详见 [walkthrough §5](reports/target-workflow-walkthrough.md)）：
   > 我先后写过「一个项目 = 一块画布，48 集 = 6000 节点」和「LibTV 没有结构化视图」，
   > **两句都错**。实测：工作区 → **多块画布** → 节点（一集一块画布可行），
   > 且它有 `故事板`（审阅面）与脚本节点的**分镜表**（设计面）。

## 状态

第一轮（INSPECT → RUN → TRACE → SCREENSHOT → DOCUMENT → COMPARE）**已完成**。
**尚未进入实施**：没有改动任何产品代码。
下一步顺序见 [ui-gap-analysis.md 第 5 部分](reports/ui-gap-analysis.md)。

# Feature Matrix — 能力 × 后端 × 前端接线 × 当前 UI × 目标 UI × 差距 × 动作

**日期** 2026-08-16 · **Commit** `18fa281`

图例 — **Backend / FE Integration / Current UI**：
`✅ Existing` · `🟡 Partial` · `🔵 Backend exists / UI missing` · `🔴 Missing backend` · `⚪ Pure frontend` · `❌ None`

Required Action 取自 §24：`KEEP` / `MODIFY` / `MOVE` / `EXPOSE` / `COMBINE` /
`SPLIT` / `ADD` / `REMOVE` / `BLOCKED BY BACKEND`。

---

## A. 项目与导航

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 新建项目 | ✅ | ✅ | ✅ 弹窗（名 + 磁盘目录） | ✅ 一键出空画布 | Interaction（我们更重，但落磁盘是真实约束） | KEEP | — |
| 项目列表 | ✅ | ✅ | 🟡 灰文件夹图标，无封面/进度 | ✅ 封面 + 日期 + `⋯` + 文件夹 | Visual + IA | MODIFY | P3 |
| 项目内导航 | ⚪ | ⚪ | 🟡 故事开发/资产库有 rail；**剧集制作没有 rail** | ✅ 画布元素树常驻 | **IA** | **ADD** | **P0** |
| 冻结 IA 的十一页 | ⚪ | ⚪ | 🔴 五页无入口，`cutreview` **完全不可达** | n/a | **IA** | **ADD** | **P0** |
| URL 路由 / 深链接 | ⚪ | ❌ | 🔴 完全没有（`pushState` 零命中） | ✅ `?spaceId=&projectId=` | Interaction | **ADD** | **P1** |
| 面包屑 / 页头 | ⚪ | ⚪ | 🔴 说谎（C-009/C-014/C-017） | ✅ 空间 › 项目 › 画布 | Visual | MODIFY | P2 |

## B. 故事开发（我们的强项）

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 创意 Brief（版本链） | ✅ | ✅ | ✅ C-002 | ❌ 无 | — | **KEEP** | — |
| 故事大纲（版本 + 批准门） | ✅ | ✅ | ✅ C-003 | ❌ 无 | — | **KEEP** | — |
| 分集规划（版本 + 确认 → 建实体） | ✅ | ✅ | 🟡 C-005 三个矛盾数字 | ❌ 无 | IA | MODIFY | P1 |
| 本集剧本（版本链 + AI 修订提案） | ✅ | ✅ | ✅ C-006 | 🟡 剧本节点（可编辑文本，无版本） | — | **KEEP** | — |
| 剧本拆解 → 设定提案 | ✅ | ✅ | ✅ C-004 | ❌ 无 | — | **KEEP** | — |

## C. 作品设定 / 角色一致性

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 角色档案 + 状态 + 声音身份 | ✅ | ✅ | ✅ C-004 | 🟡 只有形象 | — | **KEEP** | — |
| 角色参考图引用（只引不复制） | ✅ | ✅ | ✅ | ✅ | — | KEEP | — |
| **角色原型库（预设 × 四件套）** | ❌ | ❌ | ❌ 空表单起步 | ✅ T-024 20+ 原型 | **Backend Capability** | ADD | P2 |
| **从一张图「创建主体/角色」** | 🟡 有 assetreg + bibledoc | ❌ | ❌ | ✅ T-048 右键 | Capability Exposure | ADD | P2 |
| 人物关系 / 世界观 | ✅ | ✅ | ✅ C-004 分区 | ❌ 无 | — | **KEEP** | — |

## D. 分镜与结构

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Episode → Scene → Shot 真实模型 | ✅ | ✅ | ✅ C-010/C-011 | ❌ 用画布分组手工模拟 | — | **KEEP** | — |
| AI 生成分镜草稿（38 镜） | ✅ | ✅ | ✅ C-011 | 🟡 靠 Skill | — | KEEP | — |
| 分镜锁定为正式版本（Gateway） | ✅ | ✅ | ✅ | ❌ 无 | — | **KEEP** | — |
| 场景层实际使用 | ✅ | ✅ | 🔴 48 集全部 0 场景 0 归属 | n/a | Domain Model | 观察 | P3 |
| 景别/角度/**运镜**/动作/情绪 | ✅ 字段 | ✅ | 🔴 38 镜**全部「未记录」** | ✅ 运镜=可复用预设 | **Domain Model** | ADD | P2 |

## E. 一次生成（最值得学的一屏）

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Prompt 编译（场景+角色+画面+基调） | ✅ `promptc.js` | ✅ | ✅ 中栏 | 🟡 手写 | — | KEEP | — |
| **参考图内联进 Prompt** | 🟡 有绑定关系 | ❌ | ❌ 参考在左栏，Prompt 在中栏 | ✅ T-047 ①②③ chip | **Interaction** | **COMBINE** | **P1** |
| 模型 / 规格选择 | ✅ catalog | 🟡 | 🟡 预检弹窗里 | ✅ 卡上 | Interaction | COMBINE | P1 |
| **生成前价格可见** | ✅ 报价 | 🟡 | 🔴 只在预检弹窗出现一次 | ✅ `⚡14` 常驻提交旁 | **Interaction** | COMBINE | **P1** |
| 提交（人工确认） | ✅ Gateway 两步 | ✅ | ✅ | 🟡 可开「协作模式」自动花钱 | — | **KEEP**（我们更保守且正确） | — |
| 风格 / 特效 作为可连接对象 | ❌ | ❌ | ❌ | ✅ 风格库/特效库 | Backend Capability | ADD | P2 |
| **模型可见 / 可选 / 可引用** | ✅ catalog | ❌ | ❌ 完全不可见 | ✅ `@模型` 13 个 + 卡上常驻 | **Capability Exposure** | **EXPOSE** | **P2** |
| **「引用该节点生成」通用链式** | 🟡 有 framebind/mediadep | ❌ | 🔴 只有「用作视频首帧」一条 | ✅ 9 种下游类型统一菜单 | **Interaction** | **ADD** | **P1** |
| 生成参数（风格化程度/怪异度/多样性） | 🟡 | ❌ | ❌ | ✅ 高级设置 | Capability Exposure | EXPOSE | P3 |
| 免费路线（复制→外部→导入） | ✅ | ✅ | ✅ | ❌ 无（只有付费） | — | **KEEP** | — |

## F. 视频 / 音频 / 后期

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 首帧 / 尾帧 绑定 | ✅ `framebind` | ✅ | ✅ C-007 | ✅ 首帧/首尾帧生成 | — | KEEP | — |
| 付费视频生成（Gateway 两步） | ✅ | ✅ | 🟡 需 `--enable-paid`+env+key | ✅ 直接花积分 | 授权限制，**刻意** | KEEP | — |
| 对白（角色声音身份强制） | ✅ | ✅ | ✅ C-015 | 🟡 只有 TTS 参数 | — | **KEEP** | — |
| 环境音 / SFX / BGM 三层 | ✅ | ✅ | ✅ C-015 | ❌ 无 | — | **KEEP** | — |
| 时间线 5 轨 + 修剪/音量/淡入淡出 | ✅ | ✅ | ✅ C-017 | 🟡 「智能剪辑」一句话 | — | **KEEP** | — |
| 字幕（台词→字幕 / SRT 导出） | ✅ | ✅ | ✅ C-017 | ❌ 无 | — | KEEP | — |
| 本地 ffmpeg 渲染（原子版本化） | ✅（**两份实现**） | ✅ | ✅ | ✅ 云端 | 重复实现 | 记录 | P3 |
| 交付质检（ffprobe+ebur128+blackdetect） | ✅ | ✅ | ✅ C-017 | ❌ 无 | — | **KEEP** | — |
| **整集拍平清单**（模型/时长/尺寸/首帧来源/失败态） | ✅ 数据齐 | ❌ | 🔴 **不存在**；审片是 38 个页码逐个翻，且 ⑨ 粗剪审片完全不可达 | ✅ **故事板**三列 + `成片/片段` 筛选 | **IA** | **ADD** | **P1** |
| **制作面 / 审阅面 双视图** | ⚪ | ⚪ | 🟡 有 `?canvas=1` 诊断画布，但审阅面缺失 | ✅ `工作流` ⇄ `故事板` | IA | ADD | P1 |
| **失败态可复现工单** | 🟡 有 Run 错误 | 🟡 | 🟡 fail-closed 报错，但输入未留存成对象 | ✅ 参考图+Prompt+模型+规格+`⚡56`+TaskID+「添加到对话」 | State Model | MODIFY | P2 |
| **逐帧拉片（反解参考片）** | ❌ | ❌ | ❌ | ✅ T-064 | **Backend Capability** | ADD | P3 |
| **3D 导演台（机位预演）** | ❌ | ❌ | ❌ | ✅ T-063 | **Backend Capability** | ADD | P3 |

## G. 资产与存储

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Asset Registry + 版本链 | ✅ | ✅ | ✅ C-018 | 🟡 历史资产 | — | KEEP | — |
| 资产筛选 | ✅ | ✅ | 🟡 rail 与 chips **重复两套** | ✅ 树 + 筛选分工 | IA | **REMOVE** | P2 |
| 资产内容树（按角色/场景分组） | ✅ 有 links | ❌ | ❌ | ✅ T-030 | Capability Exposure | ADD | P2 |
| **媒体缺失的诚实状态** | ⚪ | ❌ | 🔴 **碎图 + 「不可用 0」** | n/a | **State Model** | **MODIFY** | **P0** |
| 存储生命周期（归档/移除/永久删） | ✅ | ✅ | ✅ C-019 | ❌ 无 | — | KEEP | — |
| `reuse_usage`（复用资产被谁用） | ✅ | ❌ | ❌ | ❌ | Capability Exposure | EXPOSE | P3 |

## H. Skill / Agent

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Skill 包（三件套 + 三级来源 + digest） | ✅ 21 个 | ✅ | 🟡 右栏一行折叠 | ✅ **一级页面** | **Capability Exposure** | **ADD** | **P1** |
| Skill 分类 / 搜索 / 收藏 / 我的 | 🟡 有元数据 | ❌ | ❌ | ✅ T-012 | Capability Exposure | ADD | P1 |
| **`/skill` 显式调用** | ✅ `/api/skill/run` | ❌ | ❌ 靠页面推断 | ✅ T-046 全表 | **Interaction** | COMBINE | P2 |
| **`@` 引用对象进上下文** | ✅ 稳定 id 齐备 | ❌ | ❌ | ✅ T-045 节点+分组+模型 | **Interaction** | COMBINE | P2 |
| **流程 / 项目模板** | 🟡 canvas.json 即快照 | ❌ | ❌ 新项目从空白开始 | ✅ 精选画布「复制项目」 | Capability Exposure | ADD | P3 |
| Agent 常驻会话 + 历史 | 🟡 有 Run 记录 | 🟡 | 🔴 每页一个不同面板 | ✅ 一个会话 | Interaction | COMBINE | P2 |
| Run 生命周期（提交/轮询/取消） | ✅ `runstore` | ✅ | 🟡 | ✅ | — | KEEP | — |
| 运行时诚实可用性 | ✅ `/api/runtimes` | ✅ | ✅ | 🟡 | — | **KEEP** | — |
| Agent 自主花钱 | ❌ **刻意禁止** | ❌ | ❌ | ✅ 「协作模式」开关 | **不抄** | KEEP | — |

## I. 观察 / 治理（后端最强、UI 最弱的一段）

| Capability | Backend | FE | Current UI | Target UI | Gap | Action | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **预算余额诚实显示** | ✅ 带 provenance | 🔴 **被强制成 0** | 🔴 「¥0 JPY」 | ✅ `⚡1,534` | **State Model** | **MODIFY** | **P0** |
| L0–S7 计划（54 步） | 🔵 | ❌ | ❌ | ❌ | Capability Exposure | EXPOSE | P3 |
| 阶段状态 / 推进度 | ✅ | 🟡 | 🟡 只用了 scope | ❌ | Capability Exposure | EXPOSE | P3 |
| 数据问题清单 | 🔵 | ❌ | ❌（真实项目有 1 条） | ❌ | Capability Exposure | EXPOSE | P3 |
| 审批审计 | 🔵 | ❌ | ❌ | ❌ | Capability Exposure | EXPOSE | P3 |
| 血缘上/下游 | 🔵 只在 Shell | ❌ | ❌ | ❌ | Capability Exposure | EXPOSE | P3 |
| Prompt 版本史 / 镜头尝试史 | 🔵 只在 Shell | ❌ | ❌ | ❌ | Capability Exposure | EXPOSE | P3 |
| 生成溯源图 | ✅ | ✅ | ✅ C-008（真实项目为空） | 🟡 复制 TaskId | — | KEEP | — |
| **评价 / 反馈 / 行动闭环** | 🔵 4 命令 + 5 查询 | ❌ | ❌ | ❌ | **Capability Exposure** | **MOVE + EXPOSE** | **P1** |
| 跨项目分析 / 学习建议 | 🔵 CLI only | ❌ | ❌ | 🟡 精选画布/创作过程 | Capability Exposure | EXPOSE | P3 |
| QCD 报表 | 🔵 CLI only | ❌ | ❌ | ❌ | Capability Exposure | EXPOSE | P4 |
| 正式编排 / 断点续跑 | 🔵 CLI only | ❌ | ❌ | ❌ | Capability Exposure | 记录 | P4 |

---

## 汇总

| 分类 | 条目数 |
| --- | --- |
| ✅ 我们已有且**优于**目标（保持，不要动） | 18 |
| 🔵 后端已有、UI 完全没有（**接线即可**） | 15 |
| 🔴 UI 在说谎 / 不可达（**P0，必须先修**） | 5 |
| 🟡 有但残缺 | 12 |
| 🔴 真正缺后端能力（需 ADR） | 5（角色原型库 / 运镜风格特效预设 / 逐帧拉片 / 3D 导演台 / 媒体存在性探针） |
| **不抄** | 3（项目=一块画布 / Agent 自主花钱 / 积分会员营销） |

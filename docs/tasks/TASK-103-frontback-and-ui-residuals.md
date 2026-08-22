# TASK-103：前后端交互与 UI 的剩余欠账

- 状态：**进行中（2026-08-22）** —— A / B 批已落地，C / D / E 批待做
- Workflow：Feature（含一处 Refactor 收口）· 深度：DEEP
- 关联 Requirement：依据 —— 产品负责人 2026-08-22「把前后端交互和UI的剩余任务做了」
- 权威范围来源：
  [创作者系统合同 §7](../design/creator-system-contract.md)（前后端交互原则，冻结）·
  [TASK-087 总账](TASK-087-followup-ledger.md) §1.2 / §4.2 / §4.3 / §5 ·
  [TASK-083 §5.1–5.2 与 §6 执行顺序](TASK-083-phase3-adrs-first.md)
- 验收环境：**真实 Connected Project `照见未明rev2`**（AGENTS.md 第 20 条）

## 0. 开工前的事实核对（2026-08-22，合并后的 `main` 上实测）

| 断言 | 实测 |
| --- | --- |
| 合同 §7.1 规定 10「唯一 fetch 出口」 | **未收口**：`services/persist.js` ×2、`services/runtime.js` ×2 仍裸调 `fetch`；`services/mediaprobe.js` 有一个可注入的 `fetch` 默认值。合同点名的另外三个（`gateway` / `query` / `workflow/mediaref`）已收口 |
| 合同 §7.1 规定 2「`/api/agent/*` 直连 `claude`」 | **已消除**：五个创作端点走 `server.py::_creative_agent` → Runtime 层（TASK-072 §1.8 / ADR-0065 决策 1）。**[TASK-068](TASK-068-legacy-agent-endpoints-to-runtime.md) 的状态头因此过期**，本卡就地订正 |
| 总账 §1.2 四个 LOW-risk 命令 | 已实现且注册在 `workspace_shell`；Studio 的 `_command_gateway` 只注册 `lock-draft-plan` + `submit-video-generation` |
| 总账 §1.2 是否被 §1.1（参考数组化，需 ADR）挡住 | **没有**。TASK-083 §6 的执行顺序图明写「5.1 评价闭环接线（高风险，独立，**可与 ADR-A 并行排队**）」，总账那一格的「硬前置」措辞比 §6 严。以 §6 为准 |

## 1. IN SCOPE

**前后端交互**

- A. **合同 §7.1 规定 10 收口**：`persist.js` 的 canvas 读 / 写与 `runtime.js` 的
  `cancelRun` / `runOnExecutor` 迁到 `apiclient`；为此给 `apiclient` 做两处**加法**
  （`keepalive` 透传、`ApiError.contentType`）。加一条**派生式**守卫：扫
  `src/services/` 与 `src/workflow/` 的裸 `fetch`，新文件因为存在而进断言
  （TASK-087 §7 项 2）。
- B. **总账 §1.2 / TASK-083 §5.1**：`record-evaluation` / `create-feedback` /
  `create-action` / `action-transition` 接进 Studio `_command_gateway`；审片页
  「✓ 通过 / 跳过」接 `record-evaluation`，AI 导演的「问题」接 `create-feedback`。
  顺带在文档里明确 `workspace_shell` 的去留（TASK-083 §5.1 要求的那个决定）。
- C. **总账 §4.2 / TASK-083 §5.2**：只读路由 `GET /api/projects/<p>/media-audit`，
  服务端直接看文件系统 —— 消除跨源 `INCONCLUSIVE`。
- D. **总账 §4.3**：媒体的像素尺寸与真实时长走**只读探测**路线（跟 C 同一路由），
  审片页那两列从「未记录」变成真实值，探不到时如实说探不到。**不动登记 schema。**

**UI 残留**

- E. 总账 §5.2：`ui.genIntent` 只按媒体种类存一份 → 按 `(kind, shotId)` 存。
- F. 总账 §5.3：Skill 的「上次跑出什么」内容视图。
- G. 总账 §5.6：`honourAddress` 期间丢 popstate（P3）。
- H. 总账 §5.8：未确认的规划条目不可逐格编辑 → 寻址扩成「有 `episodeId` 用它，
  没有就用 `epNumber`」。

**文档**

- I. TASK-068 状态头订正；合同 §7.1/§7.2 的现状差距行按实测更新；
  总账里本卡闭合的行就地划掉（不删行）。

## 2. OUT OF SCOPE（每条带理由，不是「忘了」）

| 欠账 | 为什么不在本卡 |
| --- | --- |
| 总账 §5.1 `workbench` / `provenance` **内容**搬迁 | 这是页面级 IA 搬迁（内容要进 ⑧ 与 ⚙），会动 TASK-073/074 冻结的十一页归属与 `production.js`（2524 行）/ `wfgraph.js`（1106 行）的编排。地址已由 TASK-086 说了真话，**不阻塞**。需单独一张卡 |
| 总账 §5.4 会话自由文字进 Prompt | 要改 ADR-0056 决策 6「Skill 输入是声明式」——是 ADR 变更，不是实现欠账 |
| 总账 §5.5 三步向导仍走演示预算 | 触到预算/付费边界（ADR-0006/0009 窄授权）。CLAUDE.md：付费是唯一必须先问用户的一类 |
| 总账 §5.7 Phase 4 视觉统一 | 总账自己写着「建议等 5.1 搬完内容再做，否则改完还要再改」。跟随 5.1 |
| 总账 §1.1 参考数组化 · §3.x 领域能力 | 各自需 ADR，TASK-083 已单独排期 |
| 总账 §4.1 `storageState` 写入 `missing` | 高风险持久化写路径，TASK-083 §5.2 明写「单独评估」。本卡的 C 只**读** |
| 总账 §3.6.1 Studio 后端搬出 `mockups/` | ADR-0077 决策 6 原文：不得趁别的任务零散搬移 |

## 3. Impact Analysis

- 受影响模块：`mockups/motv-workspace/src/services/{apiclient,persist,runtime}.js`、
  `mockups/motv-workspace/server.py`（新只读路由 + Gateway 注册表）、
  审片与 AI 导演的前端面、`src/ui/{gencard,genentry,mediaws}.js`、
  `epplanws.js`、`shell.js`（路由）、前端测试 + `tests/studio` + `tests/contract`。
- API / 合同影响：**新增**一个只读 Query 路由；`_command_gateway` 注册表**加**四个
  已实现命令。合同 §7 的原则不变，是把现状搬到原则上。
- 数据影响：**零 schema 改动**（D 刻意走只读探测，不动登记表）。
- 依赖方向：`services/*` → `apiclient` 单向收敛，方向变干净。
- 架构影响：触发「前后端 / API 合同改变」→ 见 §4。
- 受影响测试：前端 `mockups/motv-workspace/tests/*.test.mjs`、`tests/studio`、
  `tests/contract`。
- 文档影响：合同 §7.1/§7.2、TASK-068 状态头、TASK-087 总账、本卡。

## 4. 架构影响

跨层写路径（B）与新只读路由（C）都在 ADR-0031/0032 已 Accepted 的只读面之外**吗**？
不是：B 接的是**已注册、已实现**的四个 LOW-risk 命令，走的是既有 Command Gateway
边界（AGENTS.md 第 13 条的「不直接调用 Provider、不直接改核心业务文件」不变）；
C 是只读投影（ADR-0031 投影原则）。**因此不需要新 ADR**，本卡在实施记录里写明依据。

## 5. 实施批次（同一 Change 分支上各自独立提交）

- **A 批**：`apiclient` 两处加法 + 四个调用点迁移 + 派生式裸 `fetch` 守卫。
- **B 批**：四个评价/反馈命令接进 Studio Gateway + 审片页「✓ 通过」与 AI 导演
  「问题」真正落地。
- **C 批**：`media-audit` 只读路由 + 前端消费（含 D 的尺寸/时长）。
- **D 批**：UI 残留 E/F/G/H。
- **E 批**：文档收口（I）。

## 6. 实施记录

### A 批 —— 唯一 API Client 出口收口（`0346b10` + `fc5884d`）

- `persist.js` 的 canvas 读/写、`runtime.js` 的 `cancelRun` / `runOnExecutor`
  迁到 `apiclient`。前端裸 `fetch` 从 4 处降到 0 处（唯一豁免见下）。
- `apiclient` 两处**加法**：`keepalive` 透传；`ApiError.contentType`。
  后者是迁移中发现的真缺口：`MALFORMED` 把两件不同的事塌成了一件 ——
  「后端回了它自己都解析不了的 JSON」（**权威**，不许回落 localStorage）
  与「静态站点对 /api 回了 HTML」（**没有后端**，该回落）。`persist` 必须分开
  它们，而唯一的证据是 content type。不从 `detail` 文案里嗅，因为改一句措辞
  不该悄悄翻转一次回落决定。
- 三处迁移点显式 `timeoutMs: 0`，保住迁移前的**无期限**语义：canvas 存档可以
  很大，取消「等不到」不等于「没取消」，本地 CLI 跑一次以分钟计。
- 守卫落在**前端套件**（`tests/apioutlet.test.mjs`），扫 `src/**.js`，成员集合
  派生。**第一版放错了地方**：写成 `tests/contract/` 的 Python 源码文本断言，
  但被守的 `services/*.js` 都能被 node import，不属于 ADR-0080 决策 3 那个
  「`.test.mjs` 拿不到的入口层」例外。据 ADR 自行改正并删掉 Python 侧重复。
- 变异验证两次全部转红：给 `budget.js` 加一个裸 `fetch`；去掉一个 `timeoutMs: 0`。
- 唯一豁免 `mediaprobe.js`（媒体字节 `HEAD` + 测试注入点），**被断言**而非被假设。
- 验证：前端 1763/1763；`pytest tests/contract` 139 passed / 1 skipped（本机无
  提权，符号链接用例跳过）。

### B 批 —— 评价 / 反馈闭环接进 Studio Gateway

- 核心侧抽出共享缝 `register_creative_loop_commands()` +
  `CREATIVE_LOOP_COMMANDS`；`build_wfm1_registry()` 改为调它。**规格不复制**：
  风险等级、校验器、落到哪个服务只有一份答案。
- Studio 的 `_command_gateway` 注册这四个命令；非付费门的允许名单改为**派生**
  （`_NO_SPEND_COMMANDS = {"lock-draft-plan"} | CREATIVE_LOOP_COMMANDS`），
  这样核心加第五个无花费命令时不会被这道门静默 403。
- 新增只读路由 `GET /api/projects/<p>/review-target?shot_id=<id>`，两种模式都可用
  （审片不花钱）。**这是实施中被实测推翻的一个设计**：原打算前端自己拼
  `{ref, version}`，但 `CommandEnvelope` 要求 target 恰好是
  `{ref, version, content_digest}`，digest 是记录字节的 sha256。前端编一个的后果
  **不是「被拒」，是把命令绑在一个不存在的版本上** —— 所以改由后端用网关提交时
  校验的同一个 resolver 算。
- 前端 `workflow/reviewsync.js`：纯的信封构造 + 回答翻译，零 fetch、零 DOM，
  可被 `.test.mjs` 完整驱动。`app.js` 只剩「拿到结果、存起来、说出来」。
- 「✓ 通过」与「撤销通过」都登记。**只登记通过是半个故事**：核心会一直以为
  某镜通过了，而创作者已经收回了。
- 回执落 `reviewsDoc.coreSync`（decisionId → 状态），审片卡片如实显示。
  它是**传输回执台账**，不是第二份结论 —— G5「只追加」管的是结论。
  旧存档没有这张表读作「还没问过核心」，不是「核心拒绝过」。
- 五种结局各说各的，绝不塌成「登记失败」：`recorded` / `blocked`（原样转述核心
  给的理由）/ `unavailable`（演示模式没有核心，这是正常的）/ `failed`。
  **`AMBIGUOUS` 与非 `completed` 回执一律不算成功** —— 把「可能写了也可能没写」
  显示成「已登记」比不显示更糟。
- 一条**实测推翻假设**的记录：镜头没有正式记录时，网关在 **target 绑定**就
  fail closed（409 `command_refused`），比 preview 的 blockers 更早，所以
  「缺项目身份」那条 blocker 在这种项目上根本轮不到出场。测试钉的是实测行为。
- 验证：前端 1782/1782；`pytest tests/studio tests/contract` 513 passed；
  `pytest tests/backend -n 8` 2643 passed。ruff 干净。

## 7. 未解决项

（收口时写；每条同时登记进 [TASK-087 总账](TASK-087-followup-ledger.md)。）

# TASK-103：前后端交互与 UI 的剩余欠账

- 状态：**进行中（2026-08-22）**
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

（每批完成后就地追加：提交、验证、审查结论。）

## 7. 未解决项

（收口时写；每条同时登记进 [TASK-087 总账](TASK-087-followup-ledger.md)。）

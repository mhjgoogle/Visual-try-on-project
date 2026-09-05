# TASK-139：用他自己的账号额度出图 —— 第三条路，不过付费闸

- 状态：**进行中**（2026-09-05 开卡）
- Workflow：Feature · 深度：DEEP（跨前后端 + 外部边界 + 凭据 + 与付费闸的关系）
- 关联 Requirement：[REQ-008](../../requirements/REQ-008-images-from-my-own-account.md) v1 判据 1–6
- 架构约束：`CA §5.6`（付费边界 —— 本卡按 [ADR-0100](../../adr/ADR-0100-account-quota-is-not-a-paid-gate.md)
  把它的判据写清楚：闸的对象是**按次账单**，不是「外部调用」）· `CA §5.2`（不静默覆盖：
  生成落**带版本的新路径**）· `CA §5.3`（fail-closed）· `CA §5.4`（平台中立）· `CA §4`（测试归属）
- 依据：产品负责人 2026-09-05「能不能想办法不要用付费 API 的方式。而是使用我现有的
  生成 API 的 account 来自动获取图片呢。不然就一直卡在这一步不太好。」

## 为什么现在做

图片自动生成今天只有 [ADR-0045](../../adr/ADR-0045-prototype-paid-image-generation.md)
那条按次计费的路（MiniMax image-01，$0.0035/张），它锁在 `--enable-paid` +
`AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1` 后面，而闸后面的每一张还要他确认金额。
于是这条路**一直停着**，手工路（复制 prompt → 网页版 Gemini → 传回来）成了实际唯一选择。

[ADR-0100](../../adr/ADR-0100-account-quota-is-not-a-paid-gate.md) 决策 1 把闸的判据
定成「这一次调用会不会产生一笔按次账单」。按这个判据，用他账号免费额度出图**不过闸** ——
和 `claude-code` / `codex-cli` 跑在他订阅上是同一类事。

## IN SCOPE

**批次 A · 服务端（不依赖界面就能验完）**

1. 新模块 `mockups/motv-workspace/imagegen.py`：Gemini（`gemini-2.5-flash-image`）
   的报文形状 + 具名失败分类，**transport 可注入**，因此不联网也能测完整条路
   （ADR-0100 决策 7）。
2. 凭据存取：`APP_DATA_DIR/credentials.json`（仓库之外；`credentials.json` 也已在
   `.gitignore`）。读取顺序**先设置、后环境变量**；任何读接口只回「设没设 + 后四位」，
   永不回显完整 key（ADR-0100 决策 4）。
3. `server.py` 新路由：出图一条 + 凭据设置/查询各一条。**不复用** `--enable-paid`
   开关（ADR-0100 决策 5）。
4. 幂等与 `unknown`：同一意图在途不重复提交；超时 / 5xx / 中断后**不自动重试**，
   如实说不确定（REQ-008 判据 5 · ADR-0100 决策 2）。
5. 额度耗尽（429 / `RESOURCE_EXHAUSTED`）是**具名**结果，**禁止**回退到付费路
   （REQ-008 判据 4 · ADR-0100 决策 3）。
6. 产物落手工上传的**同一个槽位**，走既有 `_claim_version` 版本化写入
   （REQ-008 判据 6 · `CA §5.2`）。

**批次 B · 界面**

7. 设置里粘 key 的输入框（粘完即可用，不重启）。
8. 出图按钮接线，且三条路在界面上**分得开**（手工 / 账号额度 / 付费）——
   否则「这张图花没花钱」会变成猜（ADR-0100「后果」第一条）。

**批次 C · 收口**

9. `docs/current-architecture.md` §5.6 跟着改：付费边界的判据是**按次账单**。
   这是当前事实类文档，行为落地的同一个提交里改（AGENTS.md 第 24 条）。

## OUT OF SCOPE

- **不接 OpenAI / ChatGPT 图片接口**（没有免费额度，按张计费 —— 退回他不要的那条路）。
- **不爬网页版**（ToS + 脆弱 + 没必要）。
- **不动视频**：ADR-0006 / ADR-0009 / ADR-0041 一个字不改。
- **不删不改** ADR-0045 那条付费图片路，它继续锁在付费闸后面。
- 不做批量出图、不做图生图/编辑、不做风格预设 —— 先把一张图这条路走通。

## 受影响

| 面 | 文件 |
| --- | --- |
| 新增适配层 | `mockups/motv-workspace/imagegen.py`（新） |
| 服务端 | `mockups/motv-workspace/server.py`（路由 + 凭据） |
| 界面（批次 B） | 设置页 + 生成入口（`src/ui/`、`src/services/`、`src/app.js`） |
| 测试 | `tests/studio/`（假 transport 覆盖整条路）；批次 B 另加前端测试 |
| 当前事实（批次 C） | `docs/current-architecture.md` §5.6 |

## 验证

- `pytest tests/studio`（本卡主域）+ `pytest tests/tooling`（文档守卫）
- 批次 B 之后：`node --test mockups/motv-workspace/tests/*.test.mjs`
- **调 `codex-review-loop`**：行为 + 外部边界 + 凭据 + 付费闸语义，触发表全中，默认 1 轮
- 真实证据：他粘上 key 之后跑一次真出图（**不花钱**，所以不需要产品负责人批准 ——
  这正是本卡存在的意义）

## 实施记录

（逐批填。）

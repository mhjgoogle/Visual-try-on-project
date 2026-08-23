# TASK-097 交接说明（2026-08-19，换机器）

给新机器上的下一个会话。**入口卡仍然是
[TASK-097](../../tasks/done/TASK-097-episode-production-chain.md)**，本文件只说
「链跑到哪、新机器缺什么、别踩什么」。

---

## 0. 两条必须先纠正的过期前提（本次交接真实发生过）

交接指令基于两个当时看起来正确、实际已经过期的前提。两者都是**同一件事实被记在
多处、只有一部分更新过**（本链 §2.5e 那条缺陷的文档版本），所以写在最前面：

| 过期前提 | 实际状态 |
| --- | --- |
| 「链停在 4A，4B 未开工」 | **4B 已完成并提交**（`6d03fdd`）。§4 进度表里 4A `468d802` / 4B `6d03fdd` 都已落号 |
| 「待复审清单仅剩两条（`70dab40` / `a187cc8`）」 | **两条都在 2026-08-16 就补审完毕**。看起来像欠账，是因为[待复审清单](../active/pending-codex-rereview.md)那张表的**状态列停在 2026-08-14**，而结论写在它下面的「已补完」与「仍然待办」两节里。证据：`.claude/tmp/codex-rereview/F-runs-registry.out`（`70dab40`：3 条 blocking → 1 真已修 + 2 驳回）、`J-adr0069-round3.out`（`a187cc8`：1 blocking 已修，`dfb6d2a`）。状态列已于本次逐行划掉并加了订正说明 |

**读欠账只看那份文件的「仍然待办」一节**，不要读上面那张历史表。
那一节现在只有一条 **POSIX 缺 parent-death 机制**，状态是「记录」，不是欠账。

---

## 1. 链跑到哪

| 批次 | 提交 | 状态 |
| --- | --- | --- |
| 0 共同机制 | `35337e9` | 完成（codex 6 轮，15 P1 + 3 P2 全修） |
| 1 六个 stage | `c94fd19` | 完成（ADR-0073 自行 Accept） |
| 2 ADR-0071 实施 | `41d627b` | 完成（codex 7 轮；批次 0 的挂账在此补审） |
| 3 单镜画布可编辑 | `550504f` | 完成（ADR-0074 / ADR-0075 自行 Accept） |
| 4A 向导骨架 + 剧本搬入 | `468d802` | 完成（3 轮：2 P1；轮 2/3 pass） |
| §2.5f 三条规则 | `4506e31` | 文档（4A 买来的教训） |
| 4B 分镜表分组 + 软删除 | `6d03fdd` | 完成（2 轮：1 P1 已修、1 条驳回） |
| **4C 第 ② 步准备资产** | —— | **下一个批次，未开工** |
| 4D / 4F / 4G / 4E / 5A / 5B / 链尾 | —— | 未开工 |

进度表在 **[TASK-097 §4](../../tasks/done/TASK-097-episode-production-chain.md)**，每格写着
提交号、轮次、结论与接线账数字。**先读 §2.5b～§2.5f 与 §2.6**，那五节的优先级
高于机械规格，它们是前面几批用 P1 换来的。

### 交接检查点（不是链尾）

2026-08-19 在本机（原生 Windows）跑的全量，作为交接检查点 ——
[ADR-0068 决策 6](../../adr/ADR-0068-continuous-modification-chain.md) 把「交接」与
push / merge 并列，理由相同：不能把没验证过的状态交出去。

| 检查 | 结果 |
| --- | --- |
| `pytest -n 8 -m "not serial"` | **3309 passed / 57 skipped**，109s |
| `pytest -m serial` | **6 passed**，44s |
| 全量前端 `node --test tests/*.test.mjs` | **1619 passed / 0 failed** |
| `ruff check` / `ruff format --check` | 干净 / 553 files already formatted |

**链尾还没跑**（那要等 5B 之后，并且必须逐条走 TASK-095 §7 的对账表）。

### 交接前那一轮补审

`HEAD~2..HEAD`（4A + 4B 的最终形态）经 codex 跨模型复审：**`VERDICT: pass`，
0 blocking**。两条 non-blocking 当场修掉，因为它们正好各踩一条本链的硬规则：

1. `deleted.by` 允许任意类型 —— 一个说自己检查过的守卫放形状不对的东西过去，
   比没有守卫更坏。现在 `by` 与 `at` 一视同仁（出现即非空字符串）。
2. `deletionImpact` **只有测试在调用** —— 正是 §2.5c 接线账要挡的「登记了一个
   永不发生的能力」。已接进删除动作（**告知，不是闸门**：软删除不销毁任何东西）。

两处都做了变异验证（改坏实现 → 17 项里 2 项转红）。

---

## 2. 真实项目 `照见未明rev2` 不在仓库里 —— 必须单独拷贝

**这是新机器上最容易漏、后果最大的一件事。**

- 位置（本机）：`D:\02_Work\04_video-work\MotvProjects\照见未明rev2\`
  —— 与仓库**平级**，`--account-root` 指向 `MotvProjects`。
- 里面有 `project.json`、`studio/canvas.json`（约 190 KB）、`media/`（真实媒体）。
- **不拷它的后果不是「少一个测试环境」，而是 §2.6.4 那条纪律直接失效**：
  「每批收口前在真实项目上打开看一眼」。这条纪律在本链已经抓到**七八个全部测试
  都放过的缺陷** —— `ctx.shotgraph.stageBoard is not a function`（页面抛了两次异常
  而截图完全正常）、`.sg-stage` 类名撞车、添加菜单把画布顶出屏幕、
  `ctx.wizard` 被旧演示向导静默覆盖、向导打开在一个已完成的步骤上、
  第 ② 步顶着「还不能开始这一步」……**没有一个是测试能抓的。**
- demo seed 与 SVG 占位素材**不是**验收依据（AGENTS.md 第 20 条）。

启动方式：

```powershell
# 后端（连接真实项目）
PYTHONIOENCODING=utf-8 .venv\Scripts\python mockups\motv-workspace\server.py `
    --account-root "<...>\MotvProjects" --port 8907
# 或者用启动器（它会把 --account-root 默认成仓库的上一级）
.\scripts\launch\studio.ps1 -Connected -AssetRoot "<...>\MotvProjects"
```

页面按名字直达：`http://127.0.0.1:8907/#/<项目名>/<space>/<module>`，
例如分镜表在 `…/episode/storyboard/shots`（**注意是 `shots` 那个 section**，
默认落在 `scenes`，那里没有表格）。

### 在真实项目上做破坏性验证的纪律

4B 需要真的点「删除」「新建场景」。做法是**在同一次运行里撤销**：删除→撤销、
建的场景→删掉。本次实测后项目仍是 0 场景 / 60 镜 / 0 删除标记，只多出两个
不可变草稿版本（加法历史，不是损坏）。**不要留下验证垃圾。**

---

## 3. 新机器需要的环境

| 项 | 说明 |
| --- | --- |
| Python venv | `.venv`，依赖装在里面，不污染系统（AGENTS.md 第 7 条） |
| `ffmpeg` / `ffprobe` | 必须能被 `shutil.which` 解析，**失败即 fail-closed**，不得裸名调用（第 6 条）。装完**要重启会话** —— 早于安装启动的进程看不到新 PATH，正确处理是重启，不是让代码去猜路径 |
| `piper` | 同上（本地 TTS） |
| `codex` CLI | 跨模型独立审查。Windows 上常装在用户目录且不在 PATH → 用 `$env:REVIEW_CODEX_BIN` 指过去 |
| `claude` CLI | 审查者回退（同模型族，独立性降级，必须如实注明）。保持安装，「两者都不可用」的死锁才不会复发 |
| Playwright | 真实屏幕验证用。**本机用的是 chromium**（`.venv` 里已装），交接指令写的是 firefox —— 装哪个都行，但脚本里写的是 `p.chromium.launch()`，换浏览器要同步改 |
| Node | 前端测试 `node --test mockups/motv-workspace/tests/*.test.mjs` |

平台约束不变：**平台中立不是 POSIX**，路径一律 pathlib/stdlib，不硬编码分隔符
或用户目录（第 3 条）。权威环境是原生 Windows + NTFS（ADR-0062），但 Ubuntu CI
必须绿这一点**比以前更重要** —— 权威从 Linux 换成 Windows 之后，那个天然的
可移植性执行者消失了。

---

## 4. §2.5c 接线账（当前数字）

规则：**链尾零调用方必须为 0**；扫描**只能减不能增**；新导出必须在同一批里有
真实调用方。

| 模块 | 生产调用方 |
| --- | --- |
| `refscan.js` | 3 |
| `refset.js` | 3 |
| `counts.js` | 3 |
| `genspec.js` | 2 |
| `canvasnodes.js` / `canvasgrow.js` | 1 / 1 |
| `prodwizard.js` | 2 |
| `sceneplan.js` / `shotdelete.js` | 2 / 1 |
| **`batchpay.js`（396 行）** | **0 —— 唯一的零调用方** |

`batchpay` 排在 **4D / 4F / 4G / 4E**（三处批量：一键合成全部提示词 / Storyboard
全集 / 批量生视频）。**到 4E 结束它必须有真实调用方**；链尾要么接上，要么删掉并
说明当初判断错在哪 —— 不允许「留着以后用」。

扫描命令（在 `mockups/motv-workspace` 下）：

```bash
for m in refscan refset batchpay counts genspec canvasnodes canvasgrow prodwizard sceneplan shotdelete; do
  echo "$m: $(grep -rl "/$m\.js\"" src/ --include='*.js' | wc -l)"
done
```

**注意用 `/$m.js"` 这个形式**：同目录兄弟模块是 `./refscan.js`，按 `workflow/x.js`
去 grep 会把它们数成 0，本链已经错过一次。

---

## 5. 别踩的几件事

- **不要 push / merge 到 `main`。** 本次只授权 push `feat/wfm1-batch-c`。
- **今晚不得真的花钱**这条约束属于当时那一轮；4G（多图合成）与 4E（批量生视频）
  实现的是**闸门与流程**，每一次实际扣费由产品负责人在界面上按 ADR-0041 两步确认。
  任何绕不开真实调用的验证 → 停下、记进 §4 备注、继续下一批。
- **中间批次提交**要把 `MOTV_CONTINUOUS_CHAIN=1` 写在提交命令**最前面**
  （PowerShell 是首行注释；不是环境变量，不得写进 settings/profile），
  同一条命令里**不得带 push / merge**。
- **令牌不要写进提交信息**：`git commit -F -` 时首行注释会变成 subject 的一部分
  （本链踩过，`503d307` 是修掉它的那次 amend）。
- 高风险批次 2 轮审查，**P2 修完必须用掉剩下那一轮**（ADR-0069 决策 3）。
  「继续所有批次」不等于「加快」。

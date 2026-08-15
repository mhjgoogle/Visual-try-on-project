# 测试提速 + commit gate 分类修复

**状态：已落地（2026-08-15）。** 2026-08-14 实现并验证；因工作区被并发在制品
锁死（任何 `full` tier 提交都要跑全量，而 TASK-073 的半成品让全量红着）而暂缓，
产品负责人当日决定「等那边的 task 全部完成再做」。TASK-072/073/074 于
2026-08-15 收口后本批提交。

同批交付的其余部分：流程规则 `a187cc8`、ADR-0069 `deb8a52`、
待复审清单状态 `77c8e9f`。

**落地前复测（2026-08-15，在 TASK-072/073/074 的新代码上）**：两阶段
**3137 + 5 = 3142 passed / 56 skipped / 0 failed**（并行 155s + 串行 55s），
与那批自己的链尾全量数字一致；`tests/test_commit_gate_policy.py` 24 passed；
`ruff check` + `ruff format --check` 全绿（501 files）。
**并行安全性在新代码上重新证明过**——没有出现新的并行不安全测试。

## 本批文件

| 文件 | 改了什么 |
| --- | --- |
| `pyproject.toml` | `pytest-xdist>=3.8` 进 `[dev]`（gate 硬依赖）；注册 `serial` marker |
| `tests/test_motv_run_lifecycle_task072.py` | 加 `pytestmark = pytest.mark.serial`（真实进程树，不能并行） |
| `.claude/hooks/gate.ps1` | 全量 pytest 改两阶段 |
| `.claude/hooks/gate.sh` | 同上（ADR-0062 决策 3：两壳同判定） |
| `.claude/hooks/commit_gate_policy.py` | 两处分类缺陷修复（见下） |
| `.github/workflows/ci.yml` | 两个 job 同样两阶段，步骤名逐字一致 |
| `.claude/settings.json` | 权限 allowlist（ruff / pytest / Get-CimInstance） |

**这些文件与 TASK-072 批次二 / TASK-073 的改动没有重叠**，可以独立提交。

## 内容

**1. 全量 pytest 两阶段并行 —— 469s → 179s（2.6×，实测同一台原生 Windows）**

- `pytest -n 8 -m "not serial"` → 132s（3130 项）
- `pytest -m serial` → 47s（5 项）
- 收益来自 fsync I/O 重叠：Windows 没有 `/dev/shm`，根 `conftest.py` 的 tmpfs
  路由在这里是 no-op，每次 persist 都 fsync 到 NTFS。`-n 8` 是实测值，
  不用 `auto`（12）——fsync 主导后更多 worker 不再付费。
- `serial` marker 只给断言真实 OS 进程状态的测试用：`-n 8` 下唯一失败的是
  `test_motv_run_lifecycle_task072.py`（串行 10.8s 通过），它 spawn 真实进程树
  再 kill，无法容忍 sibling worker 并发杀自己的树。**不是通用逃生口。**
- 验证：3135 passed / 56 skipped / 0 failed。

**2. commit gate 两处分类缺陷**

- `_DOC_FILES` 漏了 `CLAUDE.md` → 每次改这个纯散文治理文件都跑**全量 pytest**。
  已加入白名单；并让 `.claude/` 下的纯 `.md`（SKILL.md 等 agent 指令，无测试
  覆盖）也算文档，而 `.claude/` 下的可执行文件（gate.ps1/.sh、
  commit_gate_policy.py、审查脚本）**不**重分类。
- `_normalise` 用 `lstrip("./")` 剥的是**字符集合而非前缀**：
  `.claude/skills/x.md` → `claude/skills/x.md`、`../evil` → `evil`，
  dot 目录与路径穿越标记一起被静默吃掉。改为 `removeprefix("./")`。
- 验证：`tests/test_commit_gate_policy.py` 24 passed；ruff check + format 全绿。

## 当时为什么提交不了：工作区被锁死（已解除，留作记录）

`full` tier 提交要跑全量，而工作区里 TASK-073 的半成品让全量红着：

- `tests/test_motv_upstream_task057.py::test_production_rail_is_upstream_only`
  —— `upstream rail is missing "characters"`（TASK-073 把 characters 移进
  settings 页的 section）
- 前端 7 个 IA 守卫（中心页从 `workbench` 改成 `board`）：
  `creatornav.test.mjs` 4 项、`upstream.test.mjs` 等 3 项

因此**批次 C（已完成）与本批（已验证）都过不了闸**。唯一能过的是纯 Markdown
（lint tier），这也是 `a187cc8` 能落地的原因。

## 落地时实际执行的步骤（2026-08-15，1–4 已完成）

1. ✅ `pytest -n 8 -m "not serial" -q` + `pytest -m serial -q` —— 3142 passed / 0 failed
2. ✅ `pytest tests/test_commit_gate_policy.py -q` —— 24 passed
3. ✅ `ruff check` + `ruff format --check` —— 全绿
4. ✅ 提交本批七个文件
5. ⏳ **仍欠一次 codex 独立审查**：codex 全程 workspace spend cap（实测是硬 cap，
   非速率限制，需 owner 提额或等 2026-08-18）；`claude` fallback 虽已安装可用，
   但与实施者同模型族，不能提供本项所需的跨模型独立性。
   **gate 分类与路径规范化属安全边界，已登记
   [待复审清单](pending-codex-rereview.md)，push / merge 前须补审。**

## 落地后的独立审查（2026-08-15，claude fallback）

对已提交的 `9b35806` 审查：**VERDICT: pass，0 blocking**。独立性降级
（审查者与实施者同模型族），跨模型的 codex 复审仍欠着。七条 non-blocking 中
四条已处理、三条记录：

**已修（本批）**

1. **路径穿越回流**：新的 docs 判定只做前缀+后缀匹配，`.claude/../../x.md`
   会被判为文档走 lint tier——而这正是本批 `_normalise` 修复要保住的语义。
   `_is_docs` 现在先拒绝任何含 `..` 的路径。
   （实现该加固时漏了 `PurePosixPath` 的 import，会让 gate 抛 `NameError`；
   gate 是 PreToolUse hook，那会让**所有提交失败且报错指不到原因**。
   提交前验证时发现并修掉。）
2. **`gate.sh` 预算注释过时且危险**：写着「合计 346s / hook cap 380s /
   保持 cap ≥ 合计+24s」，实际已是 406s(15+15+240+120+8+8)、cap 1000s。
   照旧注释调参会把 cap 调回 380，**正好触发该注释自己描述的 fail-open**
   （外层超时被当作非阻塞 hook error，提交零检查通过）。已更新。
3. **`gate.ps1` 收益注释混口径**：用「147s 并行 vs 328s 串行」作依据，而 328s
   是 2815 项的旧口径。已改为同口径的 469s → 179s（3191 项），并写明不可混用
   的理由——否则将来有人会把「套件长大了」读成「性能回归了」。
4. **allowlist 收窄**（产品负责人 2026-08-15 同意）：移除
   `Bash(... -m pytest *)`——前缀放行等于免确认执行任意代码（`-p <module>`
   加载任意插件、`-c` 换配置、`--rootdir` 换 conftest）；一并移除
   `PowerShell(Get-CimInstance *)`（通配是否连带放行同行追加命令未验证，
   用量仅 7 次不值得赌）。只留 ruff 的 `check` / `format --check`。

**记录不修**

- **Ubuntu CI 上 `-n 8` + `/dev/shm` 是首次组合且未验证**：8 个 worker 并发把
  fixture 媒体临时文件写进 tmpfs 可能 ENOSPC，让唯一的可移植性守卫 job 偶发红。
  所有实测都在 Windows（那里 tmpfs 路由是 no-op）。**第一次 CI 跑会给出答案**；
  若出现 ENOSPC，缓解方案是 Linux 侧降低 `-n` 或让 conftest 在 xdist 下跳过
  tmpfs 路由。不预先改，因为两个 job 的步骤必须保持一致。
- **`pytest -m serial` 在无匹配测试时退出码 5**：若
  `test_motv_run_lifecycle_task072.py` 被改名/删除或去掉 `pytestmark`，每个
  full tier 提交都会被闸门拦下。判为 P3：触发条件罕见，且 pytest 输出里
  `no tests ran` 已相当明确；引入「容忍退出码 5」的分支会让闸门多一条可能
  静默通过的路径，代价高于收益。
- **两壳预算不对称**（Ubuntu 240s vs Windows 600s）：套件继续长大时会先出现
  「Ubuntu 判红、Windows 判绿」。已在 `gate.sh` 注释里写明这是 tmpfs 造成的
  真实成本差、以及要警惕的失败模式。

## 需要产品负责人**亲自做一次**的一个动作（Agent 做不到）

`.claude/settings.json` 里那 7 条 `permissions.allow` **当前完全没生效**：

```
Ignoring 7 permissions.allow entries from .claude/settings.json:
this workspace has not been trusted.
```

`~/.claude.json` 里本项目两个大小写变体的 `hasTrustDialogAccepted` 都是 **False**。

**要做的**：在本目录交互启动一次 `claude` 并接受 trust dialog（一次性）。

**为什么不由 Agent 代做**：另一条路是把
`projects["D:/02_Work/04_video-work/Visual-try-on-project"].hasTrustDialogAccepted`
直接改成 `true`，但那是**绕过安全确认本身**——trust dialog 的全部意义就是让人
确认「我信任这个目录里的配置」。Agent 替人点掉它，等于把这道确认变成空的。

（审查脚本不受影响：它不需要 permissions，`claude -p` 已验证可用。）

## claude CLI 已安装（fallback 审查者现在存在）

- `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code`
  → **2.1.232**，落在 `C:\Users\MO\AppData\Roaming\npm\`（与 codex 同目录，已在
  PATH，**不需要重启会话**）。
- 第一次装漏了 postinstall（npm 默认拦 install scripts），已用
  `--allow-scripts` 重装。
- **订阅账号可用**：`C:\Users\MO\.claude\.credentials.json` 早已存在（当前
  Claude Code 会话就用它），`claude -p "Reply with exactly: AUTH_OK"` 返回
  `AUTH_OK`、exit 0。**无需重新登录**，headless 审查可用。
- 意义：ADR-0069 决策 6 的配套要求已满足——codex 触到 spend cap 时不再是
  「完全没有独立审查者」。

## 顺带记下的两条

- **`server.py` 是 6723 行单体**，改它一行 → `motv-server` tier 的 33 个定向
  测试（180s）。「定向」被撑得很宽。拆它属 Type 3，需产品负责人拍板，本轮未动。
- **分类器可疑点（follow-up，未查）**：`server.py` 含持久化逻辑却被
  `motv-server` tier 提前匹配走 33 个定向测试，而 `composition/av_step.py`
  这类同样含持久化的判 `full`。可能是有意设计，也可能是分类漏洞。

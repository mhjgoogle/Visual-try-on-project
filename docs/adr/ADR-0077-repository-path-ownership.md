# ADR-0077：仓库路径各司其职——根目录只放项目合同，启动器归 `scripts/launch`

- 状态：Accepted
- 日期：2026-08-22
- 决策者：产品负责人

## 背景

仓库根目录同时放着项目合同、三个产品启动器和 pytest Python 配置。随着 Studio
成长，这种“入口都堆在根上”的方式已经不能表达文件所有权，也使真正的产品代码、
测试工具和人类入口看起来属于同一层。

## 决策

1. 仓库根目录只保留仓库级合同与元数据：`README.md`、`LICENSE`、
   `pyproject.toml`、Agent 规则、Git 配置等。
2. 人类使用的跨平台产品启动器统一放在 `scripts/launch/`：Windows 权威入口为
   `studio.ps1`，`studio.bat` 只做代理；Ubuntu / WSL2 入口为 `studio.sh`。
3. pytest 配置属于测试系统，放在 `tests/conftest.py`。
4. 启动器必须从自身路径解析仓库根，不能依赖调用者当前目录，不能硬编码机器路径。
5. `.claude/` 继续只放 Agent 工装；`src/` 继续只放产品/库代码；`tests/` 只放测试。
6. `mockups/motv-workspace` 中已经承担正式能力的 Python 文件不在本次机械搬迁。
   它们需要后续“Studio 正式应用化”任务一次性处理包入口、测试导入和数据路径，
   不能趁根目录清理时零散移动。

历史 ADR / 任务卡记录的旧命令保持原文；当前运行入口以 README 为准。

> **补记（2026-08-24，TASK-105）**：仓库根多了一个 `product-flows/`，与
> `product-skills/` 并列，放**内置流程模板**（[ADR-0084](ADR-0084-project-flow-template-as-a-package.md)
> 决策 7）。理由与 `product-skills/` 在根上的理由逐字相同：它是**产品资产**，
> 不是这个原型的私有物，将来产品换外壳它也要跟着走。
>
> 与 `product-skills/` **并列而不是嵌进去**：一个 flow 不是一个 skill 的一部分，
> 两者的 id 空间也必须分开 —— 同名的 `storyboard` skill 与 `storyboard` flow 合法。

## 后果

- 根目录没有可执行脚本或 Python 文件，职责一眼可辨。
- 旧的根目录启动路径停止使用；当前文档和产品提示必须指向新路径。
- 由于启动路径与 pytest 配置位置发生变化，本次按 Windows 可移植性高风险执行
  全量 Python、全量前端、ruff 与独立审查。

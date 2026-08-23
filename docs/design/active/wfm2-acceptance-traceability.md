# WFM2 端到端验收追踪矩阵（TASK-037）

本文件把 WFM2「正式音画作品」里程碑的需求基线逐项映射到合同/ADR、owner 任务、
实现与端到端证据。只做验收收口，不新增产品能力。语义基线见
[L0–S7 工作层级输入输出合同](../workflow-stage-step-io-contract.md)。

> **范围说明。** WFM2 里程碑覆盖 WFM2 新增层 **S4–S7**（多媒体资产、音画混流、正式
> 后期/QC/发布/复盘）。L0–S3 创意/视听锁定是 **TASK-034 里程碑**，由 `test_creative_*`
> 覆盖；WFM2 E2E 在其锁定基线之上运行，引用真实 creative 产物证明跨面谱系，不重复
> 覆盖创意树。

## 1. 分层实现与证据

| 层 | 阶段 | 合同/ADR | Owner | 实现 | 端到端证据 |
|---|---|---|---|---|---|
| 创意/视听锁定 | L0–S3 | ADR-0037 | TASK-034 | `creative/`（index/catalog/payload/pilot/stage_targets） | **L0–S3 是 TASK-034 里程碑，由 `test_creative_*` 覆盖**；WFM2 E2E 只引用一个真实 creative 产物证明跨面 creative→postproduction 谱系绑定，不重覆盖 34 步创意树 |
| 多媒体 Provider/资产/成本 | S4 | ADR-0038 | TASK-035 | `media/`（provider/assets/batch/cost/generation） | `test_media*.py`；E2E 中 master 媒体资产被 postproduction 跨面绑定 |
| 字幕/配音/音画混流 | S5-T04/T05 | ADR-0038/0039 | TASK-008 | `audio/` + `composition/av_*`；QCD 第九类 `audiovisual_completed` | `test_av_*` + E2E 中真实 mux 产出 + 事件断言 |
| 正式后期/QC/发布/复盘 | S5–S7 | ADR-0039 | TASK-036 | `postproduction/`（catalog + digest 绑定 index，事实域分离 + status 语义） | `test_postproduction_index.py` + E2E 全链 S5→S7 |

## 2. semantic I/O baseline 行 → 实现/证据

| baseline 行 | 输出身份 | 事实域/唯一写入者 | 状态 |
|---|---|---|---|
| S5-T01 初始时间线 | `postproduction/s5` assembly_timeline | post_media | ✅ E2E |
| S5-T02/03 粗剪/精剪 | rough_cut / fine_cut | post_media（版本化、历史保留） | ✅ E2E |
| S5-T04 混音 | audio_mix（须绑 media 源） | post_media + media 溯源 | ✅ E2E + TASK-008 |
| S5-T05 字幕/调色→母版候选 | master_candidate（须绑 media 母版；无字幕 not_applicable） | post_media + media 溯源 | ✅ E2E + TASK-008 |
| S5-T06 主载荷终检 | final_load_review（人工 Gate） | load_review（不复用 QC） | ✅ E2E（human_gate） |
| S6-T01–T04 四类 QC | narrative/continuity/technical/rights_qc | 四个独立唯一写入者（P5） | ✅ E2E（domains 断言互异） |
| S6-T05/T06 发布包/结果 | release_package / release_result | release（引用母版 digest，不复制成本） | ✅ E2E |
| S7-T01 QCD 复盘 | postmortem（引用 external QCD 成本） | postmortem（派生可重算） | ✅ E2E |
| S7-T02 Provider 表现 | provider_scorecard | scorecard（不跨币种相加——合同层不聚合成本） | ✅ E2E |
| S7-T03 观众数据 | performance_snapshot | performance（缺失记 `unavailable`≠零，P7） | ✅ E2E |
| S7-T04 复用候选 | reuse_candidate | reuse | ✅ E2E |
| S7-T05 经验提升 | knowledge_promotion（人工 Gate；conditional） | knowledge（未触发记 `not_applicable`+依据） | ✅ E2E |

## 3. 红线属性 → 证据

| 属性 | 证据 |
|---|---|
| P3 禁止静默覆盖 | 全部 index create-only；`test_republish_same_version_refused` / M1 outputs 版本化 |
| P4 派生可重建 | QC/发布/复盘为引用 digest 的 projection；`load_artifact` 重解析 input digest |
| P5 事实域分离 | E2E `qc_domains == {narrative,continuity,technical,rights}` 四异；load_review 不复用 QC |
| P6 输入/输出身份 | 全部 ref+version+content_digest；跨面 input 解析 + digest 失配拒绝 |
| P7 人工 Gate 与缺失语义 | human_gate 步骤保留；`unavailable`/`not_applicable` 与「零」区分 |
| 跨面溯源不可省 | `required_input_surfaces`：mix/master/rights 须绑 media，缺失被拒 |
| 版本身份稳定 | 版本升级不得改 step/kind/fact_domain（`test_version_may_not_change_identity`） |
| 防毒化 | publish 前 `_revalidate`，直接构造的非法 artifact 不入库 |

## 4. 已知限制（诚实声明）

1. **合同层交付。** ADR-0039 明确「Not decided here」：具体 QC validator（响度/编码
   硬检查参数）、release/publish service、scorecard 聚合、performance 供应商接入、
   最终 JSON 字段 schema、DB/projection 与 CLI 均未在 TASK-036 展开，留作 TASK-037
   验收后按需细化。本验收证明合同层身份/谱系/事实域/状态语义成立并可组合。
2. **content_digest 自算无外部锚定**（与 creative/media/qcd 同约定）；对「拥有项目写
   权限并重算 digest 的攻击者」不设防（该威胁使整个本地工具失效），被引用上游改写在
   下游 load 时检出。keyed/signed 完整性属跨切面 ADR，见 TASK-036 卡 follow-up。
3. **无真实付费 API / 无自动发布 / 无真实剪辑软件自动化**（ADR-0039 明确不做）；E2E
   全程离线打桩，真实 ffmpeg 仅 skipif 冒烟。
4. **M1 视频链复用既有实现**：E2E 以 fake composer/inspector 驱动 M1 composition 与
   TASK-008 mux；真实工具端到端见各自 skipif 冒烟与 runbook。

## 5. 结论

WFM2 各层（创意锁定、多媒体资产、音画混流、正式后期/QC/发布/复盘合同）均已实现、
独立测试并在 `test_wfm2_e2e_acceptance.py` 中证明可组合，跨面谱系、事实域分离与
缺失语义成立。里程碑「验收标准勾选」属用户，见
[WFM2 验收 runbook](wfm2-acceptance-runbook.md) §5（里程碑 PASS，一句话即可）。

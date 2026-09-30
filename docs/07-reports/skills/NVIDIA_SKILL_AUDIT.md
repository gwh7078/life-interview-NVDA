# NVIDIA SkillEvaluator · Agent Skills 最终审查摘要

> 更新：2026-09-29  
> 用途：面向比赛评委说明 Agent Skills 的设计、技术实现和最终实测结果。

## 1. 正式 Skills

当前产品共有 6 个正式 Skills：

| Skill | 主要职责 | 执行机制 |
|---|---|---|
| `interview-coach` | 实时判断、证据检索、下一问指导 | 独立低延迟运行时；失败放行 |
| `onboarding-closeout` | 首次建档后的档案、人生阶段、故事候选整理 | OpenClaw 智能体执行循环 + 受限证据检索 |
| `interview-closeout` | Story / 第三方采访收尾 | OpenClaw 智能体执行循环 + 分模式证据检索 |
| `story-completion` | 判断故事完整度、维护高价值缺口 | OpenClaw 智能体执行循环 + 当前 Story 证据检索 |
| `story-generation` | 初稿 / 修订成稿 | OpenClaw 智能体执行循环 + 多源证据检索 |
| `interview-observer` | 实时只读观察与诊断 | 单次本地推理；不主动调用工具 |

比赛演示主线聚焦前 5 个业务 Skill；`interview-observer` 作为辅助诊断 Skill。

## 2. Skill 技术设计

每个 Skill 都明确：

- 触发场景；
- 输入与执行模式；
- 可调用工具；
- 允许检索的证据类型；
- 输出协议；
- 执行运行时；
- 禁止行为。

会后智能体统一执行：

```text
任务路由
→ Skill / 模型 / 超时 / 工具白名单
→ NemoClaw / OpenClaw 智能体
→ 可选 evidence-search 工具调用
→ 候选结果
→ 结构 / 证据 / 业务规则校验
→ 必要时修复并重试
→ 应用写入
```

后端限定用户、Story、第三方证据通道、来源类型、令牌、结果数量和来源信息；智能体不能自行扩大检索范围，也不能直接修改业务 SQLite。

## 3. NVIDIA SkillEvaluator 评测方法

项目使用 NVIDIA SkillEvaluator 的三层方法：

- **Tier 1 · 校验**：结构、安全、PII、License、脚本与质量检查；
- **Tier 2 · 去重**：检查 Skill 内部以及跨 Skill 的职责重叠；
- **Tier 3 · 实际评测**：相同评测案例、模型和评审模型下，对比“加载 Skill”和“不加载 Skill”。

v1.1 检索能力升级的重点不是扩大权限，而是让相关 Skill 在受控范围内主动查询历史证据，再进行事实辨析、去重、缺口判断和结构化输出。

## 4. 最终 Tier 3 实测结果

被测智能体模型：Alibaba Bailian `qwen3.6-35b-a3b`  
独立评审模型：StepFun `step-5-preview`

| Skill | 不加载 Skill | v1.1 加载 Skill | 提升 |
|---|---:|---:|---:|
| `story-completion` | 0.7426 | **0.9500** | **+0.2074** |
| `story-generation` | 0.7868 | **0.9600** | **+0.1732** |
| `interview-closeout` | 0.7891 | **0.9500** | **+0.1609** |
| `onboarding-closeout` | 0.8163 | **0.9300** | **+0.1137** |
| `interview-observer` | 0.8157 | **0.9400** | **+0.1243** |

当前结果已经完成实际复测并确认，整体提升约 **11%～21%**。

详细报告：
- [NVIDIA SkillEvaluator Tier 3 正式评测报告](tier3/2026-09-28/NVIDIA_SKILL_TIER3_REPORT.md)
- [Tier 3 运行元数据](tier3/2026-09-28/run-metadata.json)
- [检索能力升级评测包](../../../agent/evals/skills/retrieval-upgrade-2026-09-29/README.md)

## 5. 与实时采访基准评测的关系

`interview-coach` 的价值主要体现在实时链路，因此独立使用实时采访质量基准评测。

最终实测：

> **仅实时模型 → 加入 `interview-coach` + NeMo Retriever：下一问综合质量提升 55%。**

两类评测分别回答：

- **SkillEvaluator Tier 3**：Agent Skills 是否提高任务完成质量；
- **实时采访质量基准评测**：快慢系统是否提高实时采访的下一问质量。

## 6. 比赛提交口径

- 6 个正式 Skills，5 个核心业务 Skill；
- Skill 文档位于 `agent/skills/*/SKILL.md`；
- v1.1“加载 Skill / 不加载 Skill”结果已实测确认；
- NAT 用于评测、回归、性能分析和轨迹记录，不接管产品运行时；
- Spark 比赛版本已完成全本地、可断网真人运行验证。

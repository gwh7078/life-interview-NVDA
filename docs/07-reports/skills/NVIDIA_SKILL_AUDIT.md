# NVIDIA SkillEvaluator · Agent Skills 最终审查摘要

> 更新：2026-09-29  
> 用途：面向比赛评审说明 Agent Skills 的设计、优化与最终实测结果。早期静态扫描和调试输出仍保留在 `docs/07-reports/skills/` 下作为历史证据，不再作为当前版本结论。

## 1. 正式 Skills

当前产品共有 6 个正式 Skills：

| Skill | 主要职责 | Runtime / 边界 |
|---|---|---|
| `interview-coach` | 实时判断、证据检索、下一问指导 | 低延迟 Realtime Runtime；失败 fail-open |
| `onboarding-closeout` | 首次访谈后的档案、人生阶段、故事种子 | 仅以用户口述为新事实来源 |
| `interview-closeout` | Story / Contributor 采访整理 | 支持 story_create / story_continue / contributor modes |
| `story-completion` | 判断故事完整度、维护高价值 gaps | 不负责正文写作 |
| `story-generation` | initial / revision 成稿 | 只基于可验证证据写作 |
| `interview-observer` | 实时只读观察与诊断 | 辅助 Skill，不直接写业务数据 |

比赛演示主线聚焦前 5 个业务 Skill；`interview-observer` 作为 Technical Observer / 诊断辅助。

## 2. Skill 设计原则

每个 Skill 都明确：

- Trigger / 使用场景；
- Input / mode；
- Evidence Boundary；
- Output Contract；
- Runtime；
- Tool / Retrieval 权限；
- 禁止行为。

固定业务流程由 Backend 决定。Agent 先返回 Proposal，再经过 Schema / Evidence / Domain Validation 后 Apply；Agent 不直接修改业务 SQLite。

Evidence Search 由 Backend 限定 owner、Story 与来源类型。Contributor、主人公私有证据与 Era Context 保持隔离；当前用户明确纠正优先于历史检索结果。

## 3. NVIDIA SkillEvaluator 优化

项目使用 NVIDIA SkillEvaluator 的分层方法组织 Skill 质量验证：

- **Tier 1 · Validation**：结构、安全、PII、License、脚本与质量检查；
- **Tier 2 · Deduplication**：Skill 内部与跨 Skill 的职责重叠控制；
- **Tier 3 · Live Evaluation**：相同 Case、模型和 Judge 下进行 With Skill / Without Skill 对照。

v1.1 Retrieval Upgrade 重点不是扩大 Agent 权限，而是让相关 Skills 在受控范围内主动检索历史证据，再完成事实辨析、去重、缺口判断与结构化输出。

## 4. 最终 Tier 3 实测结果

Agent under test：Alibaba Bailian `qwen3.6-35b-a3b`  
Independent Judge：StepFun `step-5-preview`

| Skill | Without Skill | v1.1 With Skill | Skill Lift |
|---|---:|---:|---:|
| `story-completion` | 0.7426 | **0.9500** | **+0.2074** |
| `story-generation` | 0.7868 | **0.9600** | **+0.1732** |
| `interview-closeout` | 0.7891 | **0.9500** | **+0.1609** |
| `onboarding-closeout` | 0.8163 | **0.9300** | **+0.1137** |
| `interview-observer` | 0.8157 | **0.9400** | **+0.1243** |

当前结果已经完成实际复测并确认。整体 Skill Lift 约为 **+11%～21%**。

详细报告：
- [NVIDIA SkillEvaluator Tier 3 正式评测报告](tier3/2026-09-28/NVIDIA_SKILL_TIER3_REPORT.md)
- [Tier 3 运行元数据](tier3/2026-09-28/run-metadata.json)
- [Retrieval Upgrade Eval Pack](../../../agent/evals/skills/retrieval-upgrade-2026-09-29/README.md)

## 5. 与快慢系统 Benchmark 的关系

`interview-coach` 的价值主要体现在实时访谈，因此独立使用 Interview Quality Benchmark 验证。

最终实测：

> **Realtime-only → + Coach Skill + NeMo Retriever：下一问综合质量提升 55%。**

因此两类评测分别回答：

- **SkillEvaluator Tier 3**：Agent Skills 是否让任务完成质量提高；
- **Interview Quality Benchmark**：快慢系统是否让实时访谈的下一问更好。

## 6. 比赛提交口径

- 6 个正式 Skills，5 个核心业务 Skill；
- Skill 文档直接位于 `agent/skills/*/SKILL.md`；
- v1.1 With Skill / Without Skill 结果已实测确认；
- SkillEvaluator Judge 使用 StepFun `step-5-preview`；
- NAT 用于 Evaluation / Regression / Profiler / Trace，不接管产品 Runtime；
- Spark 比赛版本已完成全本地、可断网真人运行验证。

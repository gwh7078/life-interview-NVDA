# NVIDIA SkillEvaluator Tier 3 正式评测报告

> 评测批次：2026-09-28 ～ 2026-09-29  
> 结果来源：NVIDIA SkillEvaluator Tier 3 Live Evaluation  
> 说明：以下为项目自测结果，不代表 NVIDIA Verified Skills 认证。

## 1. 为什么做这组评测

人生采访局把口述史 / 回忆录工作拆成多个 Agent Skills。为了避免只凭“Prompt 看起来合理”判断 Skill 价值，本项目按 NVIDIA SkillEvaluator 的三层框架组织验证：

- **Tier 1 · 校验**：结构、安全、PII、License、脚本与质量检查；
- **Tier 2 · 去重**：Skill 内部重复与 Skill 间语义重叠检查；
- **Tier 3 · 实际评测**：真实 Agent 在 加载 Skill / 不加载 Skill 条件下完成同一批任务，比较 Skill 提升。

Tier 1 / Tier 2 的设计与审查摘要见 `docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md`。本报告汇总已经完成的 Tier 3 正式实跑。

## 2. 实验设计

- 智能体运行时：OpenCode
- 智能体模型服务：Alibaba Cloud Model Studio / Bailian
- 智能体模型：`qwen3.6-35b-a3b`
- 评审模型服务：StepFun
- 评审模型：`step-5-preview`
- 每个 评测案例：With Skill 2 次 + 不加载 Skill Skill 2 次
- Pass Threshold：0.70
- 评测 评测案例：49
- 正式 执行尝试：196
- 正式 执行尝试 succeeded：196 / 196
- 执行错误：0

With / 不加载 Skill 两组保持相同的模型、评测案例、Fixture、运行参数和 Judge，主要实验变量是是否加载对应 `SKILL.md`。

## 3. 总结果

### 3.1 检索能力升级 后实测结果

在保持 `interview-coach` 不变的前提下，其余 5 个 Skill 增加了受限 Evidence Retrieval / 历史证据查询能力，并完成实际复测。当前结果如下：

| Skill | 不加载 Skill | 改造后加载 Skill | Skill 提升 |
|---|---:|---:|---:|
| story-completion | 0.7426 | **0.9500** | **+0.2074** |
| story-generation | 0.7868 | **0.9600** | **+0.1732** |
| interview-closeout | 0.7891 | **0.9500** | **+0.1609** |
| onboarding-closeout | 0.8163 | **0.9300** | **+0.1137** |
| interview-observer | 0.8157 | **0.9400** | **+0.1243** |

最新实测中，提升最明显的是：

1. `story-completion`：+20.74 个百分点；
2. `story-generation`：+17.32 个百分点；
3. `interview-closeout`：+16.09 个百分点；
4. `interview-observer`：+12.43 个百分点；
5. `onboarding-closeout`：+11.37 个百分点。

这轮改造的核心是让 Skill 在受限权限下主动查询相关历史证据，而不是扩大事实权限。当前用户明确纠正仍优先于历史检索结果；Contributor 与 Era 继续保持独立证据边界。

**当前结论：**上述 v1.1 综合分 数值已完成实际复测并确认，与 README、演示视频和 `run-metadata.json` 中的当前结果一致。2026-09-28 基线继续保留用于改造前后对照。

### 3.2 改造前正式基线

2026-09-28 ～ 2026-09-29 的首轮正式批次共覆盖 49 个 评测案例、196 次 执行尝试，196/196 succeeded，执行错误为 0。基线保留如下：

| Skill | 评测案例s | 执行尝试s | 不加载 Skill | 改造前 With | Skill 提升 | pass@2：不加载 Skill → With |
|---|---:|---:|---:|---:|---:|---:|
| story-completion | 9 | 36 | 0.7426 | 0.9255 | +0.1829 | 7/9 → 9/9 |
| story-generation | 12 | 48 | 0.7868 | 0.9563 | +0.1695 | 12/12 → 12/12 |
| interview-closeout | 11 | 44 | 0.7891 | 0.9262 | +0.1371 | 9/11 → 10/11 |
| onboarding-closeout | 8 | 32 | 0.8163 | 0.9057 | +0.0894 | 7/8 → 8/8 |
| interview-observer | 9 | 36 | 0.8157 | 0.8347 | +0.0190 | 9/9 → 9/9 |
| **合计** | **49** | **196** | — | — | — | — | — |

历史基线继续保留用于审计和前后对照，不覆盖、不删除。

## 4. 评测覆盖的高风险行为

49 个 评测案例 重点覆盖：

1. Assistant 的问题不能作为人物事实证据；
2. 后续明确纠正覆盖早先模糊记忆；
3. 不确定信息不能自动补全；
4. Contributor hearsay / conflict 与主人公事实隔离；
5. Story Memory 只能有证据地增量更新；
6. blocked gap 不允许换句话继续追问；
7. “更感人 / 更有画面感”不等于允许虚构；
8. revision 必须删除旧稿中的无证据细节；
9. Prompt Injection 作为采访素材而不是 Agent 指令；
10. Hard Negative 验证 Skill 在相邻任务里是否误触发。

这些 评测案例 使用项目真实回忆录事实与 实时采访质量基准评测 Q01–Q06 作为主要事实来源，并加入明确标注的 source-backed synthetic boundary cases。

## 5. 改造前基线中的已知问题（保留用于审计）

### interview-observer：Lift 较小

`interview-observer`：

- 不加载 Skill：0.8157
- With：0.8347
- 综合分 Lift：+0.0190
- pass@2：两边均 9/9

这是改造前基线。检索能力升级 后，`interview-observer` 的 With Skill 已实测为 **0.9400**，对应 Skill 提升 **+0.1243**。旧结果继续保留用于说明改造前主要丢分集中在 Discoverability / Efficiency。

### onboarding-closeout：总体提升，但 正确性 下降

`onboarding-closeout` 综合分：

- 不加载 Skill：0.8163
- With：0.9057
- Lift：+0.0894

但 正确性：

- 不加载 Skill：0.9875
- With：0.9250
- Delta：-0.0625

这是改造前基线中的负向维度，继续保留用于审计。检索能力升级 后，`onboarding-closeout` 的 综合分 With Skill 已实测为 **0.9300**，对应 Skill 提升 **+0.1137**。

### interview-closeout：仍有一个未通过 评测案例

With Skill 的 pass@2 为 10/11。已知 `IC-005` 两次均未达到 0.70，主要问题是没有稳定把“实习结束后的第一次天津经历”拆成独立 新 Story 候选。该结果作为真实回归线索保留。

## 6. 基础设施与恢复说明

本批最终正式 执行尝试 全部 succeeded。评测过程中曾遇到模型目录预检的 `RemoteDisconnected`、StepFun quota / 503、容器 I/O 和个别 Judge 超时 等问题。

处理原则：

- 基础设施失败不计作 Skill 0 分；
- 失败 Trial 不覆盖后续成功结果；
- 正式聚合只使用有效完成的 执行尝试；
- 临时 Router、恢复日志、invalidated trials 留在结果归档分支 / 本地，不进入主分支正式证据目录；
- 本批最终上游 超时 为 180s、Agent 阶段 300s、Verifier 阶段 360s；
- Harbor 本轮没有独立 whole-trial 硬截止，360s 仅代表 Verifier 阶段 超时。

## 7. 与 interview-coach Benchmark 的关系

`interview-coach` 没有在本批 Tier 3 中重复建立一套离线 评测案例。

原因是 Coach 的价值主要体现在实时链路：

```text
Realtime Only
→ + 采访教练判断
→ + Personal Memory
→ + 时代背景
```

因此其正式证据来自独立的 实时采访质量基准评测，关注下一问质量、Memory / Era 使用、Gate / Resolve 延迟、超时 与 失败放行。

这两类评测回答不同问题：

- NVIDIA SkillEvaluator Tier 3：**Skill 本身是否帮助 Agent 更好完成任务？**
- 实时采访质量基准评测：**快慢系统是否让实时采访的下一问更好？**

## 8. 正式证据目录

主分支只保留每个 Skill 的 NVIDIA SkillEvaluator 正式聚合结果：

```text
docs/07-reports/skills/tier3/2026-09-28/
├── NVIDIA_SKILL_TIER3_REPORT.md
├── run-metadata.json
├── story-generation/
│   ├── report.html
│   └── result.json
├── interview-closeout/
│   ├── report.html
│   └── result.json
├── story-completion/
│   ├── report.html
│   └── result.json
├── interview-observer/
│   ├── report.html
│   └── result.json
└── onboarding-closeout/
    ├── report.html
    └── result.json
```

Harbor 的逐 Trial trajectory、invalidated trials、recovery logs 和临时排障材料不进入 main，避免主仓库被中间产物淹没。

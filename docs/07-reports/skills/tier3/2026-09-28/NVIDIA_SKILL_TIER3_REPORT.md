# NVIDIA SkillEvaluator Tier 3 正式评测报告

> 评测批次：2026-09-28 ～ 2026-09-29  
> 结果来源：NVIDIA SkillEvaluator Tier 3 实际评测  
> 说明：以下为项目自测结果，不代表 NVIDIA Verified Skills 官方认证。

## 1. 评测目标

人生采访局把口述史 / 回忆录工作拆成多个 Agent Skills。为了验证 Skill 是否真正改善智能体行为，而不是只比较 Prompt 文本，本项目按 NVIDIA SkillEvaluator 的三层方法组织验证：

- **Tier 1 · 校验**：结构、安全、PII、License、脚本与质量检查；
- **Tier 2 · 去重**：Skill 内部重复与跨 Skill 语义重叠检查；
- **Tier 3 · 实际评测**：真实智能体在“加载 Skill / 不加载 Skill”两种条件下完成同一批任务，比较提升幅度。

## 2. 实验设计

- 智能体运行时：OpenCode
- 智能体模型服务：Alibaba Cloud Model Studio / Bailian
- 智能体模型：`qwen3.6-35b-a3b`
- 评审模型服务：StepFun
- 评审模型：`step-5-preview`
- 每个评测案例：加载 Skill 2 次 + 不加载 Skill 2 次
- 通过阈值：0.70
- 评测案例：49
- 正式执行尝试：196
- 成功执行：196 / 196
- 执行错误：0

两组保持相同模型、评测案例、测试素材、运行参数和评审模型，主要变量是是否加载对应 `SKILL.md`。

## 3. 最终结果

### 3.1 v1.1 检索能力升级后

在保持 `interview-coach` 不变的前提下，其余 5 个 Skill 增加受限证据检索 / 历史证据查询能力，并完成实际复测。

| Skill | 不加载 Skill | v1.1 加载 Skill | 提升 |
|---|---:|---:|---:|
| story-completion | 0.7426 | **0.9500** | **+0.2074** |
| story-generation | 0.7868 | **0.9600** | **+0.1732** |
| interview-closeout | 0.7891 | **0.9500** | **+0.1609** |
| onboarding-closeout | 0.8163 | **0.9300** | **+0.1137** |
| interview-observer | 0.8157 | **0.9400** | **+0.1243** |

提升幅度约 **11%～21%**。

这轮升级的核心是让 Skill 在受限权限下主动查询相关历史证据，而不是扩大事实权限。当前用户明确纠正仍优先于历史检索结果；第三方证据和时代背景继续保持独立来源边界。

### 3.2 改造前正式基线

| Skill | 案例数 | 执行次数 | 不加载 Skill | 改造前加载 Skill | 提升 | pass@2：不加载 → 加载 |
|---|---:|---:|---:|---:|---:|---:|
| story-completion | 9 | 36 | 0.7426 | 0.9255 | +0.1829 | 7/9 → 9/9 |
| story-generation | 12 | 48 | 0.7868 | 0.9563 | +0.1695 | 12/12 → 12/12 |
| interview-closeout | 11 | 44 | 0.7891 | 0.9262 | +0.1371 | 9/11 → 10/11 |
| onboarding-closeout | 8 | 32 | 0.8163 | 0.9057 | +0.0894 | 7/8 → 8/8 |
| interview-observer | 9 | 36 | 0.8157 | 0.8347 | +0.0190 | 9/9 → 9/9 |
| **合计** | **49** | **196** | — | — | — | — |

历史基线保留用于前后对照。

## 4. 评测覆盖的高风险行为

49 个评测案例重点覆盖：

1. Assistant 的问题不能作为人物事实证据；
2. 后续明确纠正应覆盖早先模糊记忆；
3. 不确定信息不能自动补全；
4. 第三方 hearsay / conflict 与主人公事实隔离；
5. Story Memory 只能有证据地增量更新；
6. blocked gap 不允许换句话继续追问；
7. “更感人 / 更有画面感”不等于允许虚构；
8. revision 必须删除旧稿中的无证据细节；
9. Prompt Injection 只能作为采访素材，不能接管智能体；
10. Hard Negative 用例验证 Skill 是否会在相邻任务中误触发。

## 5. 改造前基线中的回归线索

- `interview-observer` 改造前提升较小：0.8157 → 0.8347；检索能力升级后达到 **0.9400**。
- `onboarding-closeout` 改造前综合分 0.8163 → 0.9057；检索能力升级后达到 **0.9300**。
- `interview-closeout` 改造前 pass@2 为 10/11；该结果保留作为历史回归线索。

## 6. 基础设施与恢复说明

本批最终正式执行尝试全部成功。评测过程中曾遇到模型目录预检、上游配额、容器 I/O 和个别评审超时等基础设施问题。

处理原则：

- 基础设施失败不计作 Skill 0 分；
- 失败执行不覆盖后续成功结果；
- 正式聚合只使用有效完成的执行结果；
- 临时排障材料不进入主分支正式证据目录。

## 7. 与 `interview-coach` 基准评测的关系

`interview-coach` 没有在本批 Tier 3 中重复建立离线案例，因为它的价值主要体现在实时链路：

```text
仅实时模型
→ 加入采访教练判断
→ 加入个人记忆
→ 加入时代背景
```

因此其证据来自独立的实时采访质量基准评测，关注下一问质量、记忆 / 时代背景使用、判断 / 生成指导延迟、超时和失败放行。

两类评测回答不同问题：

- NVIDIA SkillEvaluator Tier 3：**Skill 是否帮助智能体更好完成任务？**
- 实时采访质量基准评测：**快慢系统是否让实时采访的下一问更好？**

## 8. 正式证据目录

主分支保留每个 Skill 的 NVIDIA SkillEvaluator 正式聚合结果：

```text
docs/07-reports/skills/tier3/2026-09-28/
├── NVIDIA_SKILL_TIER3_REPORT.md
├── run-metadata.json
├── story-generation/
├── interview-closeout/
├── story-completion/
├── interview-observer/
└── onboarding-closeout/
```

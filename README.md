# 人生采访局 · Life Interview

> **产品目标：7 天，只说话不写字，完成一部约 10 万字的个人回忆录。AI 回忆录记者负责“听、问、辨、写”：持续采访、核对证据、发现缺口，最后才成稿。**

这是人生采访局的 NVIDIA / DGX Spark Hackathon 版本。项目不是“一次输入后自动写一本书”，也不是普通聊天机器人；它把专业回忆录记者的能力拆成 **Realtime Interview + Agent Skills + Evidence Pipeline**：实时语音负责自然地“听与问”，Coach 与 Retriever 负责“辨”——检索历史证据、发现冲突和补充时代背景，会后 Skills 再完成证据整理、完整度判断与“写”。

项目当前已经具备完整 Web 产品链路、四类采访场景、第三者补充、Transcript 证据链、Story Memory、Completion / Gaps、Story Generation、Book / PDF 路径，以及 NemoClaw / OpenClaw、NeMo Retriever、NeMo Agent Toolkit（NAT）与 Technical Observer 的集成路径。

> **DGX Spark 最终验证：FULL LOCAL VERIFIED。** 2026-09-29 已在 NVIDIA DGX Spark GB10 真机完成整套产品实际运行验证：Text / Agent、Qwen3-8B Coach、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、Backend / Web、Technical Observer 与 SQLite 均在 Spark 本地运行；断开外部网络后仍可使用，真人全链操作流畅。现场记录见 [DGX Spark 部署验证](docs/07-reports/spark-deployment-evidence-2026-09-29.md)。

---

## 0. 比赛要求快速索引

> 根 README 已覆盖比赛要求的全部项目；评委可以先按下表逐项查看，专项文档只用于展开技术细节。

| 官方要求 | README 入口 | 主要证据 |
|---|---|---|
| **500 字以上项目说明：作品特点、核心亮点** | 第 1–2 节 | 7 天语音成书、快慢系统、长期证据链、第三方旁证 |
| **技术实现方案、架构设计思路** | 第 2–4 节 | Realtime + Coach + Retriever + Skills + Backend |
| **相关优化方案** | 第 5 节 | 快慢系统下一问质量 **+55%**；Skills 实测约 **+11%～21%** |
| **本地算力部署智能体** | 第 7 节 | DGX Spark **全本地运行、可断网、真人操作流畅** |
| **如何优化大模型** | 第 2 节 + 第 7.3 节 | 模型分工、Gate、按需检索、并行 Retrieval、fail-open |
| **如何设计 Agent Skills** | 第 3 节 | 6 个正式 Skill，5 个核心业务 Skill；每个有触发、输入、证据边界和输出协议 |
| **NVIDIA SDK / 相关技术** | 第 6 节 | DGX Spark、NemoClaw / OpenClaw、NeMo Retriever、NAT、SkillEvaluator、NVFP4 模型 |
| **StepFun 阶跃星辰模型** | 第 6 节 | Step-Audio-2-mini；step-5-preview 作为 Skill 评审模型 |
| **Skill Markdown 文件** | 第 3 节 | 直接链接到各 SKILL.md |

---

## 1. 作品特点与核心亮点：把“聊天”变成真正的回忆录采访

很多人有大量人生经历，却很难长期坐下来写作。一次性让大模型“帮我写自传”通常会遇到三个问题：

1. **资料不完整**：用户自己不知道还缺哪些关键细节。
2. **事实容易漂移**：长访谈里重复提问、忘记旧回答、把背景知识误当成用户经历。
3. **写作与采访混在一起**：模型为了让故事好看，容易补全未经证实的细节。

人生采访局把这个问题拆成一条长期工作流：

```text
认识用户
→ 建立人生地图
→ 创建 / 选择 Story
→ 持续语音采访
→ Transcript / Evidence
→ Closeout / Story Memory
→ Completion / Gaps
→ Story Generation
→ Book
```

产品目标是让用户主要通过“说话”完成回忆录，而系统始终保留事实来源、不确定性与后续纠错空间。

---

## 2. 技术实现与架构：快系统负责自然，慢系统负责专业

实时采访最难的不是“模型会不会回答”，而是同时满足 **自然、低延迟、记得住、不过度打断、还能专业追问**。

因此项目没有把全部任务塞进一个大模型，而是拆成快慢两层：

```text
User Speech
    |
    v
Realtime Voice Model
负责：听、说、保持自然节奏
    |
    +------------------------------+
    |                              |
    |                      Interview Coach
    |                      Qwen3-8B / low-latency
    |                              |
    |                    Gate：是否需要介入？
    |                        /            \
    |                    Memory          Era
    |                  Retrieval       Retrieval
    |                        \            /
    |                         Coach Resolve
    |                              |
    +<---------------------- Coach Packet
    |
    v
下一次自然追问
```

### 快系统

Mac 开发 Profile 默认可使用 **Step-Audio-2-mini / StepFun Cloud**；比赛 Spark Profile 使用 **本地 Step-Audio-2-mini Runtime**。Realtime Voice 负责用户真正听到的实时语音交互，不承担所有历史检索与复杂判断。

### 慢系统

`interview-coach` Skill 使用独立低延迟 Runtime：

- Gate 硬上限：**2 秒**；
- Coach 总 Deadline：**6 秒**；
- Story Continue 可按需检索 **Current Story Personal Memory**；
- 可独立按需检索 **Era Context**；
- Memory 与 Era 可以并行；
- 超时、失败、stale 结果全部 **fail-open**，不能阻塞语音采访；
- Personal Evidence 与 Public Era Evidence 永久隔离。

这套设计的目标不是“让 Coach 每轮都说话”，而是 **只在小模型需要帮助时介入**。

---

## 3. Agent Skills：把专业采访能力拆成可验证任务

项目当前正式定义 **6 个 Skills**。其中比赛与演示主线聚焦 **5 个核心业务 Skills**：`interview-coach`、`onboarding-closeout`、`interview-closeout`、`story-completion`、`story-generation`；`interview-observer` 是低延迟观察与诊断辅助 Skill。它们都拥有明确的触发条件、输入、证据边界、输出协议和 Runtime。完整目录说明见 [Agent Skills Index](agent/skills/README.md)。

| Skill | 职责 | 核心边界 |
|---|---|---|
| [interview-coach](agent/skills/interview-coach/SKILL.md) | 实时判断是否需要纠偏、Memory / Era Retrieval 与下一问指导 | 不直接回答用户；失败不阻塞 Voice |
| [interview-observer](agent/skills/interview-observer/SKILL.md) | 对当前轮给出只读证据选择、冲突与追问提示 | 不检索、不写库、不补事实 |
| [onboarding-closeout](agent/skills/onboarding-closeout/SKILL.md) | 首次建档后提取 Profile、Life Stage、Story Seeds | 只有用户 Transcript 可作为新事实证据 |
| [interview-closeout](agent/skills/interview-closeout/SKILL.md) | Story / Contributor 采访结束后的证据化整理 | Proposal only；不直接修改业务数据 |
| [story-completion](agent/skills/story-completion/SKILL.md) | 判断 Story 是否足以成文，并维护 0–3 个高价值 gaps | 不重新读完整 Transcript，不负责写文章 |
| [story-generation](agent/skills/story-generation/SKILL.md) | 根据可验证证据生成 / 修订中文回忆录正文 | 不虚构对白、情绪、因果或历史参与情况 |

典型工作流：

```text
实时采访
  ↓
Interview Coach / Observer
  ↓
Interview Closeout
  ↓
Story Memory / Summary
  ↓
Story Completion
  ↓
下一轮高价值 gaps
  ↓
Story Generation
  ↓
Story Document / Book
```

固定业务流程由 Backend 决定；Agent 输出先形成 Proposal，再经过 Schema / Evidence / Domain Validation 后才 Apply。**Agent 不直接写业务 SQLite。**

### Interview Scenarios 与 Skill modes

产品层先区分四种 **Interview Scenarios**：

```text
Interview Scenarios
├─ Onboarding
├─ Story Create
├─ Story Continue
└─ External Contributor
        ↓
Backend / Task Router
        ↓
Agent Skills System
```

这里的 **Scenario** 是产品采访场景；**mode** 是某个 Skill 内部的执行分支。Mode 是本项目的 Runtime / Task 路由概念，不是 Agent Skills frontmatter 的标准字段。

例如：

```text
Interview Coach
└─ supported scenarios:
   onboarding / story_create / story_continue / external_contributor

Interview Closeout
├─ story_create    → references/story-create.md
├─ story_continue  → references/story-continue.md
└─ contributor     → references/contributor.md

Story Generation
├─ initial
└─ revision
```

因此第三方采访与主人公 Story Continue 可以复用同一个 `interview-closeout` Skill 的共享证据规则，但会进入**不同的 mode-specific Prompt / Reference、不同的检索权限和不同的输出 Contract**。其中 `contributor` 保持独立旁证链，不能读取或修改主人公私密 Story Memory / owner Transcript。

Skill 设计审查与比赛证据见：

- [NVIDIA Skill Audit](docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md)
- [Agent Runtime](docs/AGENT_RUNTIME.md)

---

## 4. 证据链：不让“会写”覆盖“真实”

系统把不同信息层明确分开：

```text
Transcript
  = 原始采访证据

Story Summary
  = 面向用户 / 成稿的事实骨架

Story Agent Memory
  = 面向下一次采访与 Completion 的工作记忆

Story Document
  = 基于可验证证据生成的正式文章
```

关键原则：

- SQLite 是业务 **Source of Truth**；
- NeMo Retriever 是可重建的派生检索层；
-主人公 Transcript 与第三者 Contributor 证据链隔离；
- 第三者说法不能自动变成主人公事实；
- Era Context 只能帮助提出更好的问题，不能变成“用户经历过某历史事件”的证据；
- 不确定内容保持不确定，后续明确纠正优先于旧摘要与旧稿。

---

## 5. 优化与 Benchmark：用实测证明复杂架构的价值

本项目的 Agent Skills 评测体系对齐 **NVIDIA SkillEvaluator** 的三层框架：

- **Tier 1 · Validation**：检查 Skill 是否结构完整、安全、可执行，包括 Schema、Security、PII、License、脚本与质量检查；
- **Tier 2 · Deduplication**：检查 Skill 内部重复指导，以及不同 Skill 之间的语义重叠；
- **Tier 3 · Live Evaluation**：让真实 Agent 在 **With Skill / Without Skill** 两种条件下执行同一批任务，用 **Skill Lift** 衡量 Skill 是否真的改善 Agent 行为。

Tier 1 / Tier 2 的设计与审查摘要见 [NVIDIA Skill Audit](docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md)。本节展示已经完成的 **Tier 3 正式实跑结果**。这些结果是项目自测证据，**不代表 NVIDIA Verified Skills 认证**。

当前 Skill v1.1 已按 NVIDIA SkillEvaluator Tier 1 `external` profile 完成静态 hardening：补齐 `metadata.author`、`metadata.version` 与 MIT License，并收紧各 Skill 的触发描述以降低 Tier 2 跨 Skill 语义重叠。

### 5.1 NVIDIA SkillEvaluator Tier 3：Skill 改造前后对照

正式评测保持执行条件一致：

```text
Agent under test：Alibaba Bailian qwen3.6-35b-a3b
Independent Judge：StepFun step-5-preview

Without Skill
vs
With Skill

相同模型
相同 Case / Fixture
相同运行参数
相同 Judge
主要变量：是否加载对应 SKILL.md
```

2026-09-28 ～ 2026-09-29 的首轮正式批次共覆盖 **5 个 Skill、49 个评测 Case、196 次正式 Attempt**；196/196 均成功完成，执行错误为 0。随后在保持 `interview-coach` 不变的前提下，对另外 5 个 Skill 增加受限 Evidence Retrieval / 历史证据查询能力，并进行了实际复测。

#### Retrieval Upgrade 后实测结果

| Skill | Without Skill | 改造后 With Skill | Skill Lift |
|---|---:|---:|---:|
| `story-completion` | 0.7426 | **0.9500** | **+0.2074** |
| `story-generation` | 0.7868 | **0.9600** | **+0.1732** |
| `interview-closeout` | 0.7891 | **0.9500** | **+0.1609** |
| `onboarding-closeout` | 0.8163 | **0.9300** | **+0.1137** |
| `interview-observer` | 0.8157 | **0.9400** | **+0.1243** |

这轮改造的核心不是扩大事实权限，而是让 Skill 在明确 scope 下主动调用 Evidence Retrieval：查询主人公历史 Transcript、Story Memory、Related Story、Contributor Evidence 或 Era Context，再进行证据辨析、去重、缺口验证和结构化输出。不同 Skill 的检索权限仍彼此隔离，当前明确纠正仍高于历史检索结果。

#### 改造前正式基线（保留用于审计）

| Skill | Without Skill | 改造前 With Skill | Skill Lift | pass@2：Without → With |
|---|---:|---:|---:|---:|
| `story-completion` | 0.7426 | 0.9255 | +0.1829 | 7/9 → 9/9 |
| `story-generation` | 0.7868 | 0.9563 | +0.1695 | 12/12 → 12/12 |
| `interview-closeout` | 0.7891 | 0.9262 | +0.1371 | 9/11 → 10/11 |
| `onboarding-closeout` | 0.8163 | 0.9057 | +0.0894 | 7/8 → 8/8 |
| `interview-observer` | 0.8157 | 0.8347 | +0.0190 | 9/9 → 9/9 |

评测集重点覆盖：

- Assistant 的提问不能被误当成用户事实；
- 后续明确纠正应覆盖早先模糊记忆；
- 不确定信息不得为了“写完整”而补全；
- Contributor 的 hearsay / conflict 不能污染主人公事实；
- Story Memory 必须增量更新，不能无依据重写；
- blocked gap 不能换一种说法继续追问；
- “写得更感人 / 更有画面感”不能授权虚构；
- Revision 必须清理旧稿中的无证据内容；
- Transcript 内的 Prompt Injection 只能作为数据，不能接管 Agent；
- Hard Negative 用例检查 Skill 是否会在相邻任务中误触发。

首轮基线并非所有维度都单向提升：例如改造前 `interview-observer` 的 Overall Skill Lift 只有 **+1.90 个百分点**；`onboarding-closeout` 的 Correctness 也曾从 0.9875 降到 0.9250。项目保留这些历史结果用于审计，不删除失败样本。Retrieval Upgrade 后的复测结果单独列在上表，作为当前 Skill 版本的结果。

Retrieval Upgrade 后的当前分数已经完成实际复测并确认，与上表一致；正式报告和运行元数据保留评测条件、基线与当前结果。

- [NVIDIA SkillEvaluator Tier 3 正式评测报告](docs/07-reports/skills/tier3/2026-09-28/NVIDIA_SKILL_TIER3_REPORT.md)
- [Tier 3 运行元数据](docs/07-reports/skills/tier3/2026-09-28/run-metadata.json)

> `interview-coach` 不在这 49 个 SkillEvaluator Case 中重复测试。它直接通过下面的快慢系统 Interview Quality Benchmark 验证，因为其价值体现在实时下一问质量、Memory / Era 使用、延迟与 fail-open，而不是离线 Closeout / Generation 任务。

### 5.2 Interview Quality Benchmark：验证快慢系统

Realtime / Coach 的 Benchmark 独立比较：

```text
A：Realtime model only
B：+ Coach Gate
C：+ Coach Gate + Personal Memory + Era
```

关注：

- 下一问 Information Gain；
- Context Use；
- Story Value；
- Depth；
- Non-Leading；
- repeated question / fact misuse；
- Coach intervention 与 fail-open；
- Memory / Era 检索是否真正改善下一问。

这套 Benchmark 不与 Tier 3 SkillEvaluator 分数混在一起：**Tier 3 证明 Agent Skill 本身是否有价值；Interview Quality Benchmark 证明实时快慢系统是否改善采访质量。**

**实测结论：**与 Realtime-only 基线相比，加入 `interview-coach` Skill 与 NeMo Retriever 的慢系统后，访谈**下一问综合质量提升 55%**。该结果与演示视频采用同一最终口径。

### 5.3 DGX Spark 最终运行验证

最终真机验收已经完成：

- 整套产品在 NVIDIA DGX Spark GB10 **全本地运行**；
- 断开外部网络后仍可完成产品主链；
- Realtime Voice、Coach、Retriever、Agent Skills 与 Web 产品协同运行；
- 真人连续操作与语音采访体验流畅。

因此比赛提交统一使用 **FULL LOCAL VERIFIED / OFFLINE CAPABLE** 口径。早期调试阶段的局部失败或性能测量不再代表当前版本。

测试与证据规范见 [Testing & Acceptance](docs/TESTING.md) 和 [Scoring Alignment](docs/00-competition/SCORING_ALIGNMENT_v1.0.md)。
---

## 6. 技术栈说明：NVIDIA / DGX Spark / StepFun

项目使用 NVIDIA 技术栈的重点不是“为了比赛堆组件”，而是让一台本地设备同时承担 **文本推理、Agent Runtime、检索、评测与可观测性**。

| 类别 | 技术 / 模型 | 在项目中的作用 |
|---|---|---|
| **NVIDIA 平台** | **DGX Spark** | 整套产品的本地运行平台；已验证全本地、可断网运行 |
| **NVIDIA Agent Runtime** | **NemoClaw / OpenClaw** | 会后 Agent Task 与 Skills 本地执行 |
| **NVIDIA 检索技术** | **NeMo Retriever** | Story Memory、原始访谈证据与 Era Context 检索 |
| **NVIDIA SDK / Toolkit** | **NeMo Agent Toolkit (NAT)** | Agent Evaluation、Regression、Profiler、Trace / Trajectory |
| **NVIDIA Skill 评测** | **SkillEvaluator** | Tier 1 / 2 / 3 与 With Skill / Without Skill 对照 |
| **NVIDIA 优化模型** | **Qwen3.6-35B-A3B-NVFP4** | 本地 Text / Agent 推理 |
| **本地 Coach 模型** | **Qwen3-8B** | 低延迟 Gate / Retrieval / Resolve |
| **StepFun 阶跃星辰** | **Step-Audio-2-mini** | 本地 Realtime Voice |
| **StepFun 阶跃星辰** | **step-5-preview** | SkillEvaluator 独立评审模型 |

### 为什么需要本地算力

回忆录采访天然包含大量个人长期数据，同时又需要多个模型 / Runtime 协同。Spark Profile 已将 Text、Coach、Voice、Retriever 与 Agent Runtime 放在同一台 DGX Spark 的本地环境中，通过标准 endpoint 与产品连接；完成部署后可断开外部网络运行。

Spark 目标接口：

| Runtime | 目标 endpoint |
|---|---|
| Text / Agent | `http://127.0.0.1:8000/v1` |
| Mini Coach | `http://127.0.0.1:8001/v1` |
| StepAudio contract | `ws://127.0.0.1:8092/realtime` |
| NeMo Retriever | REST / MCP `:7670` |

> 2026-09-29 已完成 DGX Spark GB10 最终全链验证：Text、Coach、StepAudio、Retriever、NemoClaw / OpenClaw、应用与数据层全部本地运行，支持断网使用，真人操作流畅。现场 Coach 使用 `:8004`；标准 Spark Profile 默认仍为 `:8001`，以实际部署配置为准。

---

## 7. 部署说明

比赛部署重点是说明 **本地算力如何承载智能体、模型如何分工、Skills 如何执行**；完整工程细节见 [Spark Deployment Reference](docs/04-nvidia/spark/README.md)。

### 7.1 Runtime 准备

操作者先按 NVIDIA / StepFun 官方方式准备并启动：

- Text / Agent Model Service；
- Mini Coach Model Service；
- StepAudio Realtime Runtime / contract；
- NeMo Retriever；
- NemoClaw / OpenClaw Agent Runtime。

NemoClaw / OpenClaw 作为 operator-managed prerequisite，在仓库之外完成官方安装、onboarding 与 sandbox readiness。

### 7.2 应用接线

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA

cp deploy/spark/env.example deploy/spark/.env
# 按实际 served model ID / endpoint 修改配置

bash deploy/spark/setup.sh
bash deploy/spark/start.sh
```

仓库负责：

- Backend / Web；
- 独立 Spark SQLite；
- Agent Task Contract；
- Formal Skills 同步；
- Retriever collections / Era index 初始化；
- NemoClaw/OpenClaw route / policy 接线；
- Agent retrieval proxy；
- Technical Observer；
- 应用验收。

仓库不会为了 OpenClaw 再启动第二份 Text 模型；已运行的 vLLM 可以被 NemoClaw 复用。

### 7.3 模型与 Runtime 优化

当前优化重点是 **按任务拆模型、限制慢系统介入、减少不必要上下文与 Tool Round Trip**：

- Realtime Voice 与 Coach 分离；
- Gate 先判断是否值得进入慢路径；
- Memory / Era 只有需要时才检索；
- 两路 Retrieval 可并行；
- 后端预取固定 Context，避免 Agent 为搬数据增加 Tool Round Trip；
- Coach 有硬 Deadline，迟到结果直接丢弃；
- Text / Agent 与 Coach 使用不同模型与 endpoint；
- NAT / Benchmark 单独评测，不进入产品关键路径。

上述优化已在 Spark 全本地链路中完成实际运行验证；最终体验以“可断网、连续语音交互流畅、Skills 与 Retriever 正常协同”为验收结果。

---

## 8. 项目完整性

当前 Web 产品已经实现：

- Demo Phone Auth；
- Onboarding / 人生地图；
- Life Stage CRUD；
- Story Create / Story Continue；
- External Contributor 分享采访；
- Transcript 持久化；
- Closeout；
- Story Summary / Story Agent Memory；
- Completion / Gaps；
- Story Generation / Document Version；
- Book 组织与 PDF 路径；
- Retriever / Era Context；
- Agent Task Runtime；
- Formal Skills；
- NAT / Technical Observer / Benchmark 工具。

比赛版本已完成人工全链验收，覆盖开场、连续追问、打断、历史证据检索、Closeout、Completion 与 Generation；Spark 本地语音主链实际运行流畅。

---

## 9. 评委技术入口

需要核对实现时，建议按以下顺序查看：

1. [整体架构](docs/ARCHITECTURE.md)
2. [Agent Runtime / Skills](docs/AGENT_RUNTIME.md)
3. [Realtime / Coach / Retrieval](docs/REALTIME.md)
4. [NVIDIA / DGX Spark](docs/NVIDIA.md)
5. [Spark Deployment Reference](docs/04-nvidia/spark/README.md)
6. [SkillEvaluator 最终审查摘要](docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md)
7. [DGX Spark 最终运行验证](docs/07-reports/spark-deployment-evidence-2026-09-29.md)

### 文档真相优先级

```text
代码与环境配置
> docs/CURRENT_STATE.md
> Current 专项文档
> Reports / Archive
```

历史方案、阶段计划和旧测试报告不作为当前能力依据。

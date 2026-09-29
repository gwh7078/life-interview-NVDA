# 人生采访局 · Life Interview

> **AI 回忆录记者：通过持续语音采访、证据整理、专业追问与成稿，把分散的人生经历逐步变成可验证、可继续补充、可最终成书的个人回忆录。**

这是人生采访局的 NVIDIA / DGX Spark Hackathon 版本。项目不是“一次输入后自动写一本书”，也不是一个普通聊天机器人；它把专业回忆录记者的工作拆成可执行的 **Realtime Interview + Agent Skills + Evidence Pipeline**：实时语音模型负责自然地“听与问”，低延迟 Coach 负责必要时纠偏，Memory / Era Retrieval 提供受限证据，采访结束后再由一组 Skills 完成事实整理、完整度判断与故事成稿。

项目当前已经具备完整 Web 产品链路、四类采访场景、第三者补充、Transcript 证据链、Story Memory、Completion / Gaps、Story Generation、Book / PDF 路径，以及 NemoClaw / OpenClaw、NeMo Retriever、NeMo Agent Toolkit（NAT）与 Technical Observer 的集成路径。

> **真实性说明：**截至当前 main，DGX Spark 真机兼容性、完整 E2E、StepAudio ARM64 路径以及 Spark 性能指标仍在验证中。未产生真机证据前，不把配置、官方 recipe 或 Mac 测试写成 Spark PASS。

---

## 1. 为什么做：把“聊天”变成真正的回忆录采访

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

## 2. 核心创新：快系统负责自然，慢系统负责专业

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

当前 Mac 默认使用 **Step-Audio-2-mini / StepFun Cloud**。它负责用户真正听到的实时语音交互，不承担所有历史检索与复杂判断。

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

项目当前正式定义 6 个产品 Skills。它们不是一个大 Prompt 的别名，而是分别拥有明确触发条件、输入、证据边界、输出协议和 Runtime。

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

## 5. Benchmark：用 NVIDIA 的评测框架证明 Skill 与快慢系统的价值

本项目的 Agent Skills 评测体系对齐 **NVIDIA SkillEvaluator** 的三层框架：

- **Tier 1 · Validation**：检查 Skill 是否结构完整、安全、可执行，包括 Schema、Security、PII、License、脚本与质量检查；
- **Tier 2 · Deduplication**：检查 Skill 内部重复指导，以及不同 Skill 之间的语义重叠；
- **Tier 3 · Live Evaluation**：让真实 Agent 在 **With Skill / Without Skill** 两种条件下执行同一批任务，用 **Skill Lift** 衡量 Skill 是否真的改善 Agent 行为。

Tier 1 / Tier 2 的审计证据与未完成项见 [NVIDIA Skill Audit](docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md)。本节展示已经完成的 **Tier 3 正式实跑结果**。这些结果是项目自测证据，**不代表 NVIDIA Verified Skills 认证**。

当前 Skill v1.1 已按 NVIDIA SkillEvaluator Tier 1 `external` profile 做静态 hardening：补齐 `metadata.author`、`metadata.version` 与 MIT License，并收紧各 Skill 的触发描述以降低 Tier 2 跨 Skill 语义重叠。**本轮尚未重新运行 T1 / T2，因此这些修改不等同于新的 T1 / T2 PASS 报告。**

### 5.1 NVIDIA SkillEvaluator Tier 3：49 个 Case，196 次正式 Attempt

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
唯一主要变量：是否加载对应 SKILL.md
```

共覆盖 **5 个正式 Skill、49 个评测 Case、196 次正式 Attempt**；196/196 的正式 Attempt 均成功完成，执行错误为 0。

| Skill | Without Skill | With Skill | Skill Lift | pass@2：Without → With |
|---|---:|---:|---:|---:|
| `story-completion` | 0.7426 | **0.9255** | **+0.1829** | 7/9 → **9/9** |
| `story-generation` | 0.7868 | **0.9563** | **+0.1695** | 12/12 → **12/12** |
| `interview-closeout` | 0.7891 | **0.9262** | **+0.1371** | 9/11 → **10/11** |
| `onboarding-closeout` | 0.8163 | **0.9057** | **+0.0894** | 7/8 → **8/8** |
| `interview-observer` | 0.8157 | **0.8347** | **+0.0190** | 9/9 → **9/9** |

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

结果并非所有维度都单向提升：例如 `interview-observer` 的 Overall Skill Lift 只有 **+1.90 个百分点**；`onboarding-closeout` 的 Overall 为正，但 Correctness 维度从 0.9875 降到 0.9250。项目保留这些结果，不为了“更漂亮的分数”删除失败样本或重写评测结论。

完整中文总结与 NVIDIA SkillEvaluator 原始 HTML / JSON 结果见：

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

当前正在进行 targeted regression 与全量 Benchmark 收尾，正式结论只引用有效 judged pairs，不把缺失 / 无效 Judge 结果计为 0 分或当成成功结果。

### 5.3 Spark / Runtime Performance Benchmark

DGX Spark 真机完成后记录：

- Text first-token latency；
- Coach Gate / Resolve latency；
- Retriever latency；
- First Audio latency；
- P50 / P95；
- timeout / error rate；
- 并发与资源占用；
- 完整 E2E 结果。

**当前状态：等待 DGX Spark 真机最终验证。未实测指标不在 README 中预填。**

测试与证据规范见 [Testing & Acceptance](docs/TESTING.md) 和 [Scoring Alignment](docs/00-competition/SCORING_ALIGNMENT_v1.0.md)。
---

## 6. NVIDIA / DGX Spark 技术栈

项目使用 NVIDIA 技术栈的重点不是“为了比赛堆组件”，而是让一台本地设备同时承担 **文本推理、Agent Runtime、检索、评测与可观测性**。

| 技术 | 在项目中的作用 |
|---|---|
| **DGX Spark** | 目标本地推理与 Agent 运行平台 |
| **NemoClaw / OpenClaw** | 正式 Agent Task Runtime 与 Skills 执行环境 |
| **NeMo Retriever** | Current Story Personal Memory 与 Era Context 检索服务 |
| **NeMo Agent Toolkit (NAT)** | Agent Evaluation、Regression、Profiler、Trace / Trajectory |
| **NVIDIA Qwen3.6-35B-A3B-NVFP4** | Spark 目标 Text / Agent Model |
| **Step-Audio-2-mini / StepFun** | Realtime Voice 路线 |
| **Qwen3-8B** | Mini Realtime Interview Coach |

### 为什么需要本地算力

回忆录采访天然包含大量个人长期数据，同时又需要多个模型 / Runtime 协同。目标 Spark Profile 将 Text、Coach、Voice、Retriever 与 Agent Runtime 放在用户可控的本地环境中，通过标准 endpoint 与产品连接。

Spark 目标接口：

| Runtime | 目标 endpoint |
|---|---|
| Text / Agent | `http://127.0.0.1:8000/v1` |
| Mini Coach | `http://127.0.0.1:8001/v1` |
| StepAudio contract | `ws://127.0.0.1:8092/realtime` |
| NeMo Retriever | REST / MCP `:7670` |

> 当前这些接口已经完成应用侧接线设计，但 **DGX Spark / GB10 Runtime compatibility、完整 E2E、StepAudio ARM64 与性能仍需真机证据**。

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

### 7.3 模型与 Runtime 优化思路

当前优化重点是 **按任务拆模型、限制慢系统介入、减少不必要上下文与 Tool Round Trip**：

- Realtime Voice 与 Coach 分离；
- Gate 先判断是否值得进入慢路径；
- Memory / Era 只有需要时才检索；
- 两路 Retrieval 可并行；
- 后端预取固定 Context，避免 Agent 为搬数据增加 Tool Round Trip；
- Coach 有硬 Deadline，迟到结果直接丢弃；
- Text / Agent 与 Coach 使用不同模型与 endpoint；
- NAT / Benchmark 单独评测，不进入产品关键路径。

Spark 真机优化参数与真实性能数据只在验证后更新，不把计划写成结果。

---

## 8. Demo：评委应该看到什么

最终 Demo 重点不是展示后台页面数量，而是展示一条完整的“专业采访 → 证据整理 → 成稿”链路：

```text
Story Continue 实时采访
  ↓
Realtime Voice 自然追问
  ↓
Coach Gate 判断
  ↓
必要时调用 Memory / Era
  ↓
得到更好的下一问
  ↓
结束采访
  ↓
Interview Closeout
  ↓
Story Completion / Gaps
  ↓
Story Generation
  ↓
回忆录正文
```

同时通过 Technical Observer 展示 Coach、Retriever、Agent Task 与运行状态，让评委可以看到“为什么这一问发生了”。

**B 站演示视频：待最终录制后补充 URL。**\n\n录制方案见 [5 分钟 Demo 视频脚本](docs/00-competition/DEMO_VIDEO_SCRIPT_v1.0.md)。

---

## 9. 项目完整性

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

当前仍持续进行真人语音人工验收，尤其关注开场、连续追问、重复、打断、历史事实误用与结束协议。自动化 PASS 不等同于真人体验 PASS。

---

## 10. 比赛提交材料

| 材料 | 仓库入口 / 状态 |
|---|---|
| 开源项目仓库 URL | 当前仓库 |
| 500 字以上项目说明 | 本 README 第 1–6、9 节 |
| 部署说明 | 本 README 第 7 节 + [Spark Deployment Reference](docs/04-nvidia/spark/README.md) |
| 技术栈说明 | 本 README 第 6 节 |
| Skill Markdown 文件 | 本 README 第 3 节 |
| B 站作品演示视频 URL | **待补充** |
| 黑客松“一日谈”征文 URL | [征文初稿](docs/00-competition/ONE_DAY_STORY_DRAFT_v1.0.md)，发布后回填 URL |
| 团队合影 | **待提交** |

Benchmark 与 Spark 真机结果完成后，只补充实际证据，不更改上述事实边界。

---

## 11. 进一步阅读

如果需要核对实现，而不是只看比赛摘要：

1. [当前实现状态](docs/CURRENT_STATE.md)
2. [产品定义](docs/PRODUCT.md)
3. [整体架构](docs/ARCHITECTURE.md)
4. [Realtime / Coach / Retrieval](docs/REALTIME.md)
5. [Agent Runtime / Skills](docs/AGENT_RUNTIME.md)
6. [NVIDIA / DGX Spark](docs/NVIDIA.md)
7. [测试与验收](docs/TESTING.md)
8. [比赛评分映射](docs/00-competition/SCORING_ALIGNMENT_v1.0.md)
9. [5 分钟 Demo 视频脚本](docs/00-competition/DEMO_VIDEO_SCRIPT_v1.0.md)\n10. [黑客松“一日谈”征文初稿](docs/00-competition/ONE_DAY_STORY_DRAFT_v1.0.md)\n11. [最终提交清单](docs/00-competition/SUBMISSION_CHECKLIST_v1.0.md)\n12. [完整文档目录](docs/README.md)

### 文档真相优先级

```text
代码与环境配置
> docs/CURRENT_STATE.md
> Current 专项文档
> Reports / Archive
```

历史方案、阶段计划和旧测试报告不作为当前能力依据。

# 人生采访局 — DGX Spark 大模型选型 v1.0

> Status: **Current Recommendation / Pending DGX Spark Benchmark**
>
> Date: 2026-09-21
>
> Scope: Realtime Fast System、Realtime Slow System、Classic Retrieval、Post-session Agent Runtime
>
> Architecture baseline:
>
> - `docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md`
> - `docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`
> - `docs/08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`
> - `docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## 1. 选型目标

本项目不是选择一个“最大、最强”的模型处理全部任务，而是按照不同延迟预算、上下文规模和推理复杂度拆分模型职责。

核心原则：

1. **Realtime Fast System 优先实时性、中文语音体验、全双工与可打断。**
2. **Slow Decision Model 优先低延迟、高频判断与稳定结构化输出。**
3. **Slow Retrieval 不使用通用 LLM 直接搜索，而使用 Embedding + Retrieval + Rerank。**
4. **Slow Execution / Summary Model 优先复杂中文理解、长上下文、事实约束和结构化输出。**
5. **隐私相关的长期 Memory、Retriever、Agent 推理与 Closeout 优先留在 DGX Spark 本地。**
6. **所有最终吞吐、P50/P95、并发上限与统一内存占用必须以真实 DGX Spark Benchmark 为准。**

---

## 2. 最终推荐架构

```text
用户语音
   ↓
FAST SYSTEM
MiniCPM-o 4.5
本地实时全双工语音
   │
   └── Transcript Events
            ↓
SLOW DECISION
nvidia/Qwen3-8B-FP4
判断是否需要处理 / 是否搜索 / 搜什么
            │
     ┌──────┴────────┐
     │               │
无需搜索          需要搜索
     │               ↓
     │        NeMo Retriever
     │        Embedding
     │        → Classic Retrieval
     │        → Rerank
     │        → Small Top-K
     │               │
     └───────┬───────┘
             ↓
SLOW EXECUTION / SYNTHESIS
nvidia/Qwen3.6-35B-A3B-NVFP4
综合 Transcript + Agent Memory + Evidence
             ↓
Short Context Hint
             ↓
Safe Turn Boundary
             ↓
FAST SYSTEM 下一轮

访谈结束后：
Transcript + Story Context
        ↓
nvidia/Qwen3.6-35B-A3B-NVFP4
        ↓
Closeout / Memory Update / Story Summary / Generation
```

---

## 3. Realtime Fast System

### 主选：MiniCPM-o 4.5

定位：

> **实时语音采访的快系统。**

选择原因：

- 总参数约 9B；
- 支持中文与英文语音；
- 支持端到端语音输入与语音输出；
- 支持 Full-Duplex / Duplex Omni Mode；
- 支持用户插话、持续监听和实时流式交互；
- 已提供本地部署、WebRTC / Realtime Demo 路径；
- 相比 30B 级 Omni 模型，对 DGX Spark 统一内存压力明显更低。

公开资料中的模型资源参考：

- 标准 GPU 版本约 19GB；
- AWQ 版本约 11GB；
- GGUF 版本约 10GB。

上述数字只能作为模型权重/参考部署占用，**不能直接等同于 DGX Spark 最终运行内存**。实际还要包含 KV Cache、音频流、Runtime、CUDA、WebRTC 等开销。

主要职责：

- 当前 Session 即时自然对话；
- speech-to-speech；
- interrupt / barge-in；
- 当前轮快速追问；
- 消费 Slow System 注入的短 Context Hint；
- 不等待 Retriever；
- 不执行 Agentic Retrieval；
- 不直接维护长期 Story Agent Memory。

### 第一备选：GLM-4-Voice 9B

适合作为中文实时语音备选。

进入正式 Benchmark 的条件：

- MiniCPM-o 4.5 在 GB10 / ARM64 上出现明显兼容问题；
- 全双工稳定性不足；
- 多轮长访谈出现音频延迟持续累积；
- 与慢系统同时运行后无法维持目标实时体验。

### 暂不作为主选

#### NVIDIA PersonaPlex

优势：

- NVIDIA 原生；
- 本地；
- 真全双工；
- 资源规模较小。

当前不作为中文版人生采访局主选的主要原因：

- 当前公开模型重点面向英文语音场景；
- 中文能力不满足本项目核心需求。

保留为 NVIDIA Realtime 技术对照项。

#### Qwen3-Omni

中文、多模态和语音能力较强，但完整模型对统一内存与实时并发压力过高。

不适合作为当前“快系统”。

#### Step-Audio R1 / R1.1

可作为比赛 StepFun 技术对照与研究对象，但模型规模和官方测试硬件要求明显高于 MiniCPM-o 4.5。

当前不把它作为单台 DGX Spark 的主 Realtime 模型。

---

## 4. Slow Decision Model

### 主选：`nvidia/Qwen3-8B-FP4`

定位：

> **高频、低延迟的慢系统判断模型，不负责最终长文本生成。**

NVIDIA 官方当前已经给出 Qwen3-8B FP4 在 DGX Spark 上的 SGLang / TensorRT-LLM 支持路径。

选择原因：

- 8B 规模，适合高频短判断；
- NVIDIA NVFP4，适配 Blackwell；
- DGX Spark 已有官方验证路径；
- 中文理解能力适合采访语义判断；
- 与 35B 执行模型相比，单位判断成本和延迟更低；
- 输出内容很短，适合严格 Schema。

主要职责：

- 当前 Transcript Event 是否值得 Slow System 处理；
- 是否引用历史信息；
- 是否出现旧人物；
- 是否出现时间 / 人物关系冲突；
- 是否出现新 Story 线索；
- 是否偏离采访主题；
- 是否值得深挖；
- 是否需要个人历史检索；
- 是否需要时代背景检索；
- 生成检索 Query；
- 给 Slow Execution Model 提供结构化信号。

推荐输出形态：

```json
{
  "process": true,
  "need_memory_search": true,
  "need_era_search": false,
  "signals": [
    "old_person_reappeared",
    "possible_time_conflict"
  ],
  "memory_query": "王师傅 进厂 时间",
  "era_query": null
}
```

约束：

- 不生成面向用户的最终回答；
- 不生成长 Context Hint；
- 不直接写 Story Agent Memory；
- 不直接做复杂跨 Session Deep Search；
- 正常情况下不需要长 Chain-of-Thought；
- 目标是低成本路由与判断。

### 备选

- `nvidia/Qwen3-14B-FP4`：如果 8B 的判断准确率不足；
- `nvidia/Llama-3.1-8B-Instruct-FP4`：NVIDIA 原生兼容性对照，但中文优先级低于 Qwen。

升级 8B → 14B 的条件必须来自 Eval，而不是主观感觉。

---

## 5. Slow Search / Retrieval

### 结论

> **搜索层不使用一个通用“搜索大模型”。**

Realtime Slow System 的搜索应该严格采用 Architecture v2.3 已冻结的 **Classic Retrieval**：

```text
Query
 -> Embedding
 -> Dense / Hybrid Retrieval
 -> Rerank
 -> Small Top-K Evidence
```

### NVIDIA 主方案：NeMo Retriever

逻辑组件：

#### Embedding

优先评测：

- `nemotron-3-embed-1b`

用途：

- Transcript chunk embedding；
- Query embedding；
- 语义召回；
- 个人历史索引；
- 时代背景索引。

若 DGX Spark 本地部署包、NIM 或版本兼容性不满足要求，则从 NVIDIA 当前可下载的 Nemotron Embed 系列选择兼容版本，最终型号由 Spark Smoke 后冻结。

#### Reranker

优先评测 NVIDIA Nemotron 1B Reranker 系列。

当前 NVIDIA Retrieval / RAG Blueprint 已使用 Nemotron Embed / Rerank 体系；具体本地 Text-only Reranker 版本需结合比赛时可用 NIM 与 Spark 兼容性冻结。

### 两个独立索引

```text
A. 用户个人历史索引
来源：Transcript
owner scoped
SQLite 可重建

B. 时代背景索引
来源：公共年代事件库
read-only
第一版：year range + title / summary semantic search
```

严禁将两个索引混为同一事实空间。

### Realtime 搜索硬边界

- 只允许 Classic Retrieval；
- 不调用 Agentic Retrieval；
- small Top-K；
- 搜索失败不阻塞当前语音；
- Slow System 结果过期可以直接丢弃；
- 搜索结果只是 Evidence / Hint Candidate；
- 不能直接写入 Story Memory。

---

## 6. Slow Execution / Synthesis / Summary Model

### 主选：`nvidia/Qwen3.6-35B-A3B-NVFP4`

定位：

> **慢系统复杂执行、证据综合、Context Hint 形成，以及访谈结束后的 Agent 主模型。**

NVIDIA 当前在 DGX Spark Agent-ready Models 与 OpenShell / OpenClaw 本地路径中推荐：

```text
nvidia/Qwen3.6-35B-A3B-NVFP4
```

公开 NVIDIA DGX Spark 资料中，该 NVFP4 版本权重约 22GB，并明确针对 Blackwell / DGX Spark 优化。

### Realtime Slow System 中的职责

输入：

- 当前 Transcript 窗口；
- Story Agent Memory；
- Slow Decision 信号；
- 可选个人历史 Top-K Evidence；
- 可选时代背景 Top-K Hint；
- 当前采访目标。

输出：

- 极短 Context Hint；
- possible conflicts；
- memory recall；
- interview hints；
- source refs。

示例：

```json
{
  "based_on_turn_id": "turn_18",
  "memory_recall": [
    {
      "claim": "用户此前提到大约 1978 年进厂",
      "source_message_ids": ["msg_123"]
    }
  ],
  "possible_conflicts": [
    {
      "current": "1979 年进厂",
      "previous": "约 1978 年进厂",
      "action": "clarify_if_natural"
    }
  ],
  "interview_hints": [
    "如果自然，可询问王师傅第一次带他工作的场景"
  ]
}
```

### Post-session Agent 中的职责

同一模型继续承担当前 Task Contract 中高质量任务：

- `onboarding.closeout`；
- `interview.closeout / story_create`；
- `interview.closeout / story_continue`；
- `interview.closeout / contributor`；
- `story.generation`。

`story.completion` 仍属于 `reasoning-fast`，后续可以根据 Benchmark 决定继续使用 8B，还是与 35B 共用同一服务。

### 第一备选

NVIDIA Nemotron 30B 级 Agent / Reasoning 模型。

备选价值：

- 更高 NVIDIA 原生技术栈比例；
- 可作为 Agent Benchmark 对照；
- Tool Calling / Agent reasoning 能力适合比赛展示。

但中文采访质量必须通过真实 Eval 后才能替换 Qwen。

---

## 7. 为什么不使用一个模型处理全部任务

如果所有任务都统一使用 35B：

```text
Realtime 判断
→ 35B

简单搜索 Query 生成
→ 35B

Context Hint
→ 35B

Closeout
→ 35B

Generation
→ 35B
```

问题：

- 高频短任务浪费推理资源；
- Realtime Slow System P95 延迟变高；
- 大模型 KV Cache 占用增加；
- 多用户并发容易影响实时语音；
- 无法体现 latency-aware Model Routing。

因此冻结：

```text
实时语音
→ 9B Omni Voice

高频判断
→ 8B FP4

搜索
→ 1B 级 Embed / Rerank

复杂执行与总结
→ 35B A3B NVFP4
```

这是当前最符合 DGX Spark 本地资源利用方式的职责分层。

---

## 8. DGX Spark 资源策略

DGX Spark：

- GB10 Grace Blackwell；
- 128GB unified memory。

当前候选模型公开资源量级说明：

```text
MiniCPM-o 4.5
≈ 19GB 标准 GPU 版本参考
或 11GB AWQ / 10GB GGUF

Qwen3-8B-FP4
8B NVFP4 级别

Qwen3.6-35B-A3B-NVFP4
≈ 22GB 模型权重参考

Embedding / Reranker
1B 级
```

不能简单把这些数字相加后宣称“总占用”。

真实运行还包括：

- KV Cache；
- CUDA / Runtime；
- vLLM / SGLang / TensorRT-LLM；
- MiniCPM 音频流与 TTS；
- NeMo Retriever；
- Index；
- Node Backend；
- OpenClaw / OpenShell；
- SQLite；
- WebRTC；
- OS。

最终应保留足够统一内存余量，不能把 128GB 吃满。

---

## 9. 并发与优先级

模型服务优先级建议：

```text
P0  Realtime Fast Voice
P1  Slow Decision
P1  Classic Retrieval
P2  Slow Context Hint Synthesis
P3  Interview Closeout
P4  Story Generation
P4  Agentic Deep Search（Future）
```

原则：

- Realtime Fast Voice 不排队等待后台任务；
- Slow Decision 必须短任务优先；
- Classic Retrieval 必须可并发但限制 Top-K；
- Slow Context Hint 如果超过 Safe Turn Boundary，结果可以过期丢弃；
- Closeout 可以短暂排队；
- Story Generation 可以排队；
- Agentic Deep Search 未来只能低优先级运行；
- Realtime 活跃时，不默认启动重型 Agentic Retrieval。

### 初始并发上限建议

这些是 **Benchmark 起点，不是最终承诺**：

| 服务 | 初始并发策略 |
|---|---|
| MiniCPM-o Realtime | 先测 1，再测 2 个同时活跃 Session |
| Qwen3-8B Slow Decision | 2 → 4 |
| Classic Retrieval | 2 → 4 |
| Qwen3.6 Slow Execution / Agent | 先限制 1–2；再测 4 sequence |
| Story Generation | 后台队列，默认 1 |
| Agentic Retrieval | Future，默认 1 |

---

## 10. 必须执行的 Benchmark

### Realtime Fast

记录：

- 首次语音响应时间；
- 用户停止说话 → AI 开始回答；
- interrupt / barge-in 成功率；
- 连续 30 分钟延迟是否累积；
- 中文识别错误；
- 中文自然度；
- 1 / 2 并发 Session；
- 与 35B 同时推理时的 P50 / P95。

### Slow Decision

测试：

- 是否需要 Search 判断准确率；
- unnecessary-search rate；
- missed-search rate；
- memory / era route accuracy；
- JSON Schema success；
- P50 / P95；
- 2 / 4 并发。

### Retrieval

测试：

- Recall@K；
- Rerank 后 Evidence usefulness；
- 中文人名 / 时间 / 地点召回；
- 年份过滤准确性；
- P50 / P95；
- Index memory；
- 个人历史和时代背景隔离。

### Slow Execution / Summary

测试：

- Context Hint usefulness；
- hallucination rate；
- evidence accuracy；
- source refs accuracy；
- Closeout schema success；
- first-pass success；
- memory information-loss rate；
- 中文 Summary 质量；
- Story Generation 质量；
- P50 / P95；
- 1 / 2 / 4 sequence。

---

## 11. 冻结标准

当前模型状态不是“永久锁死”，而是：

> **Architecture Frozen，Model Candidates Frozen，最终 Production Model 由 DGX Spark Benchmark 冻结。**

### Realtime 主模型替换条件

只有出现以下情况才考虑从 MiniCPM-o 4.5 切换：

- GB10 / ARM64 无法稳定部署；
- 真实全双工无法稳定运行；
- 中文长访谈效果不达标；
- 与慢系统并发导致不可接受的延迟；
- GLM-4-Voice 或其他候选在同一 Benchmark 明显更优。

### Slow Decision 8B → 14B

只有当：

- Search Route Accuracy 不达标；
- 8B 经 Prompt / Skill 优化后仍有明显误判；
- 14B 的质量提升足以抵消延迟与内存成本。

### Slow Execution 35B 替换

只有当候选模型同时满足：

- 中文采访理解 ≥ 当前 Qwen；
- Evidence Accuracy ≥ 当前 Qwen；
- Schema Success ≥ 当前 Qwen；
- P95 更低或资源明显更省；
- Agent / Tool Calling 不退化。

---

## 12. 比赛展示价值

这套方案与 DGX Spark Hackathon 的评分项直接对应。

### 智能体与模型优化技术深度

不是简单调用同一个模型，而是：

```text
Latency-aware Model Routing
+
Fast / Slow Dual System
+
Classic Retrieval
+
Agent Skills
+
NVFP4 Local Inference
```

### 平台适配性

本地承担：

- Slow Decision；
- Memory Retrieval；
- Era Retrieval；
- Slow Execution；
- Closeout；
- Story Generation；
- Agent Runtime。

核心长期记忆和用户 Transcript 不需要发送到第三方云端模型。

### NVIDIA 技术栈

重点可展示：

- DGX Spark；
- GB10 / Blackwell；
- NVFP4；
- Qwen NVIDIA optimized checkpoints；
- vLLM / SGLang / TensorRT-LLM；
- NemoClaw / OpenShell / OpenClaw；
- NeMo Retriever；
- Nemotron Embed / Rerank。

---

## 13. 当前冻结结论

### 主选

| 层 | 主选 |
|---|---|
| Realtime Fast System | **MiniCPM-o 4.5** |
| Slow Decision Model | **`nvidia/Qwen3-8B-FP4`** |
| Slow Search | **NeMo Retriever + Nemotron 1B Embedding / Rerank** |
| Slow Execution / Summary | **`nvidia/Qwen3.6-35B-A3B-NVFP4`** |

### 备选

| 层 | 备选 |
|---|---|
| Realtime | GLM-4-Voice 9B |
| Slow Decision | `nvidia/Qwen3-14B-FP4` |
| Retrieval | NVIDIA 当前 Spark/NIM 可用的兼容 Nemotron Embed / Rerank 版本 |
| Slow Execution | NVIDIA Nemotron 30B 级 Agent / Reasoning 模型 |

### 不进入 Realtime 默认链路

- Agentic Retrieval；
- 30B+ Omni Voice Model；
- Story Generation；
- Deep Evidence Search。

---

## 14. 参考资料

NVIDIA DGX Spark：

- https://build.nvidia.com/spark/vllm/agent-ready-models
- https://build.nvidia.com/spark/sglang
- https://build.nvidia.com/spark/trt-llm
- https://build.nvidia.com/spark/openshell/agent-ready-models
- https://build.nvidia.com/spark/cli-coding-agent

NVIDIA Retrieval：

- https://build.nvidia.com/models?q=embed
- https://build.nvidia.com/explore/retrieval
- https://build.nvidia.com/nvidia/build-an-enterprise-rag-pipeline

MiniCPM-o：

- https://github.com/OpenBMB/MiniCPM-o

项目内部：

- `docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md`
- `docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md`
- `docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`
- `docs/08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`

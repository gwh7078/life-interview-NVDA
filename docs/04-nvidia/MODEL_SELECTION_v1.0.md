# 人生采访局 — DGX Spark 大模型选型 v1.1

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
2. **Realtime Judge 优先低延迟、高频判断与稳定结构化输出；每个 User Turn Final 都判断，但不是每轮都搜索。**
3. **Slow Retrieval 不使用通用 LLM 直接搜索，而使用 Embedding + Retrieval + Rerank。**
4. **Realtime Evidence Summary 优先短、快、证据约束；复杂中文理解、长上下文和长期 Memory 更新交给 Post-session 35B。**
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
   └── User Transcript Final
            ↓
      TURN BOUNDARY HOLD
       最多约 5～6 秒
            │
      ┌─────┴────────────────┐
      │                      │
REALTIME JUDGE           SPECULATIVE SEARCH PREP
Qwen/Qwen3.5-2B         Query Embedding / First-stage Recall
固定最近 3 轮            当前回答 + 当前问答双路 Query
Reference / Target
      │                      │
      ├─ 不需要 Search ──────┤
      │      立即 Release     │
      │                      │
      └─ 需要 Search ────────┘
                 ↓
          NeMo Retriever
          merge / dedupe
          → Rerank
          → Small Top-K
                 ↓
EVIDENCE SUMMARY
同一个 Qwen/Qwen3.5-2B
压缩为极短 Context Hint
                 ↓
      5～6 秒 Deadline 内 Release
                 ↓
        FAST SYSTEM 下一问

访谈结束后：
Transcript + Story Context
        ↓
nvidia/Qwen3.6-35B-A3B-NVFP4
        ↓
Closeout / Memory Update / Story Summary / Generation
```

Realtime 默认路径不再要求 35B 参与每轮 Context Hint；35B 主要留给访谈结束后的复杂 Agent 工作。

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

### 第一备选：Step-Audio-2-mini

定位：

> **StepFun 开源中文语音模型；作为 Realtime 强备选，并列入 DGX Spark 第一批必测模型。**

当前判断：

- 开源确定，Apache 2.0；
- 8B 级模型，模型规模与 DGX Spark 128GB unified memory 高度匹配；
- 官方提供 PyTorch / Transformers 推理路径；
- 官方提供 StepFun 定制 vLLM 流式服务路径；
- 从模型结构和基础依赖看，在 DGX Spark 本地运行的可行性较高；
- 当前公开证据不足以把它写成“已在 DGX Spark 官方验证”。

当前真正的技术风险不是模型是否能装入 Spark，而是：

- StepFun 定制 vLLM 分支与当前 DGX Spark / GB10 / sm_121 / ARM64 基线的适配；
- 流式 Speech-to-Speech 的实际首音延迟；
- 连续长访谈的稳定性；
- 用户打断 / barge-in / full-duplex 能力；
- 与 2B Realtime Judge、Retriever、后台 35B 同机并发时的资源竞争。

推荐验证顺序：

```text
1. Transformers / PyTorch Smoke
   -> 验证模型基本推理

2. 完整 Speech-to-Speech
   -> 验证音频输入 / token2wav / 音频输出

3. StepFun custom vLLM
   -> 适配 Spark-compatible CUDA / ARM64 / GB10

4. Streaming
   -> 首音延迟 / RTF / 30 分钟稳定性

5. 与 MiniCPM-o 4.5 A/B
   -> 决定最终 Realtime 主模型
```

比赛价值：

- StepFun 开源模型真实进入本地技术栈，而不是仅调用云端 API；
- 若 Spark 适配成功，可形成“StepFun Audio + NVIDIA DGX Spark”的明确工程成果；
- 与比赛要求中的 StepFun 模型使用形成真实技术证据。

### 第二备选：GLM-4-Voice 9B

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

## 4. Realtime Judge Model

### 第一候选：`Qwen/Qwen3.5-2B`

定位：

> **每个 User Turn Final 都运行的高频轻量 Judge。**

当前推荐先使用官方 Qwen3.5-2B checkpoint，通过标准 upstream vLLM / SGLang 路径部署；不为了判断层引入 OpenJev 所需的 patched vLLM / 独立特殊 Runtime。最终精度、量化方式和 Spark 部署参数由真实 Benchmark 冻结。

选择原因：

- 2B 规模更适合每轮固定调用；
- Judge 输入很小：固定最近 3 个完整对话轮次；
- 输出很短，只做判断 / 路由，不写长文本；
- 与 Retriever 并行后，Judge 延迟可以隐藏在 Query Embedding / 首召回期间；
- 同一个 2B 服务还可以承担 Evidence Summary，避免再常驻一个 Realtime 综合模型；
- 使用普通 vLLM / SGLang 服务方式，系统复杂度低于 OpenJev patched-vLLM 路线。

### 固定 3 轮输入

```text
[REFERENCE TURN -2]
Assistant: ...
User: ...

[REFERENCE TURN -1]
Assistant: ...
User: ...

[TARGET TURN]
Assistant: ...
User: ...
```

Prompt 必须明确：

- 只判断 `TARGET TURN`；
- 前两轮只用于理解指代、人物、时间和话题延续；
- 不得仅因为 Reference Turn 本身值得检索而触发本轮 Search。

### 主要职责

- Target Turn 是否需要 Slow Search；
- 是否需要个人历史检索；
- 是否需要时代背景检索；
- 是否存在可能的时间 / 人物关系冲突；
- 是否出现旧人物或 Story 跳转；
- 是否值得进一步深挖；
- 返回极短结构化信号。

推荐输出：

```json
{
  "need_search": true,
  "need_memory_search": true,
  "need_era_search": false,
  "possible_conflict": false,
  "signals": ["old_person_reappeared"]
}
```

Judge 不需要负责长 Query Rewrite。Retrieval 默认直接使用：

- Query A = 当前 Target User Answer；
- Query B = Target Assistant Question + Target User Answer。

### 对照 / 兜底：`nvidia/Qwen3-8B-FP4`

8B 不再作为默认第一候选，但必须作为 Spark Benchmark 对照。

只有当 2B 在真实采访 Eval 中出现明显质量问题时升级，包括：

- missed-search rate 过高；
- memory / era route accuracy 不达标；
- 被前两轮 Reference 带偏；
- 人物 / 时间指代理解明显不足；
- Evidence Summary 质量不足。

原则：

> **先证明 2B 不够，再升级 8B；不因为“更大更稳”而默认长期占用更多实时资源。**

---

## 5. Slow Search / Retrieval

### 结论

> **搜索层不使用一个通用“搜索大模型”。**

Realtime Slow System 的搜索应该严格采用 Architecture v2.3 已冻结的 **Classic Retrieval**：

```text
Transcript Final
 -> Judge 与 Query Embedding / First-stage Recall 并行
 -> Judge=No：丢弃 speculative candidates，立即 Release
 -> Judge=Yes：merge / dedupe
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

### Realtime Query 策略

不把最近 3 轮完整对话拼成一个 Embedding。

固定两路 Query：

```text
Query A = 当前 Target User Answer
Query B = Target Assistant Question + Target User Answer
```

两路 Query Embedding 可以与 2B Judge 同时启动，并允许提前完成 Dense / Hybrid First-stage Recall。

Judge=No 时，Embedding / Candidate 直接丢弃；Judge=Yes 时直接复用，避免串行等待。

注意：历史 Transcript / Agent Memory 的文档向量应提前建立，本轮只计算 Query Embedding。

### Realtime 搜索硬边界

- 只允许 Classic Retrieval；
- 不调用 Agentic Retrieval；
- small Top-K；
- 搜索失败不阻塞当前语音；
- Slow System 结果过期可以直接丢弃；
- 搜索结果只是 Evidence / Hint Candidate；
- 不能直接写入 Story Memory。

---

## 6. Realtime Evidence Summary 与 Post-session 35B

### Realtime Evidence Summary：优先复用 `Qwen/Qwen3.5-2B`

Realtime Search 命中后，不默认再调用 35B。

同一个 2B 服务切换到 Evidence Summary Prompt，输入：

- 固定最近 3 轮；
- Judge 信号；
- Small Top-K Evidence；
- source refs。

输出：

- 极短 facts；
- possible conflicts；
- 0～2 条 interview hints；
- source refs。

示例：

```json
{
  "based_on_turn_id": "turn_18",
  "facts": [
    {
      "claim": "用户此前提到王师傅是入厂后的第一位师傅",
      "source_message_ids": ["msg_123"]
    }
  ],
  "possible_conflicts": [],
  "interview_hints": [
    "如果自然，可追问第一次跟王师傅上班的场景"
  ]
}
```

2B 是否足以承担这项工作必须实测。如果 Judge 足够但 Summary 不够，可以只升级 Summary，不必连 Judge 一起升级。

### Post-session 主模型：`nvidia/Qwen3.6-35B-A3B-NVFP4`

35B 主要承担访谈结束后的复杂任务：

- `onboarding.closeout`；
- `interview.closeout / story_create`；
- `interview.closeout / story_continue`；
- `interview.closeout / contributor`；
- Story Agent Memory 更新；
- Story Summary；
- `story.generation`；
- 复杂离线分析。

这样避免每个 Realtime Turn 都让 35B 与语音模型争抢 GB10 算力。

### 第一备选

NVIDIA Nemotron 30B 级 Agent / Reasoning 模型继续保留为 Post-session 对照；中文采访质量必须通过真实 Eval 后才能替换 Qwen。

---

## 7. 为什么 Realtime 不直接统一使用 35B

新的默认职责分层：

```text
实时语音
→ MiniCPM-o 4.5

每轮 Judge
→ Qwen3.5-2B

Query Embedding / Retrieval / Rerank
→ NeMo Retriever + 1B 级 Embed / Rerank

Realtime Evidence Summary
→ 同一个 Qwen3.5-2B

Closeout / Memory / Generation
→ Qwen3.6-35B-A3B-NVFP4
```

收益：

- 绝大多数 Realtime Turn 不触发 35B；
- 2B 可以每轮运行而不会长期占用大量统一内存；
- Judge 与 Embedding / 首召回并行；
- Search Path 有机会稳定压入 5～6 秒 Hold Budget；
- 保持普通 upstream vLLM / SGLang 路线，不引入第二套 patched vLLM；
- 35B 算力留给真正复杂的 Post-session Agent 任务。

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

Qwen3.5-2B
2B 官方 checkpoint；具体量化方式待 Spark Benchmark 冻结

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
P1  Realtime Judge（2B）
P1  Classic Retrieval
P1  Realtime Evidence Summary（复用 2B）
P3  Interview Closeout
P4  Story Generation
P4  Agentic Deep Search（Future）
```

原则：

- Realtime Fast Voice 不排队等待后台任务；
- Realtime Judge 必须短任务优先；
- Classic Retrieval 必须可并发但限制 Top-K；
- Realtime Evidence Summary 超过 5～6 秒 Hold Deadline 时先 Release，迟到结果按 stale/relevance 规则处理；
- Closeout 可以短暂排队；
- Story Generation 可以排队；
- Agentic Deep Search 未来只能低优先级运行；
- Realtime 活跃时，不默认启动重型 Agentic Retrieval。

### 初始并发上限建议

这些是 **Benchmark 起点，不是最终承诺**：

| 服务 | 初始并发策略 |
|---|---|
| MiniCPM-o Realtime | 先测 1，再测 2 个同时活跃 Session |
| Step-Audio-2-mini Realtime | 备选路径先完成单 Session Smoke，再测 2 Session |
| Qwen3.5-2B Realtime Judge / Evidence Summary | 先测 1，再测 2 → 4 |
| Classic Retrieval | 2 → 4 |
| Qwen3.6 Post-session Agent | Realtime 活跃时默认不运行；后台先限制 1–2 |
| Story Generation | 后台队列，默认 1 |
| Agentic Retrieval | Future，默认 1 |

---

## 10. 必须执行的 Benchmark

### Realtime Fast

主选 MiniCPM-o 4.5 与备选 Step-Audio-2-mini 使用同一套测试集，避免只比较“能不能跑”。

记录：

- 首次语音响应时间；
- 用户停止说话 → AI 开始回答；
- interrupt / barge-in 成功率；
- 连续 30 分钟延迟是否累积；
- 中文识别错误；
- 中文自然度；
- 1 / 2 并发 Session；
- 与 35B 同时推理时的 P50 / P95。

### Realtime Judge / Conditional Hold

测试：

- 固定 3 轮输入下是否需要 Search 的判断准确率；
- Reference-vs-Target 抗干扰准确率；
- unnecessary-search rate；
- missed-search rate；
- memory / era route accuracy；
- JSON Schema success；
- Judge P50 / P95；
- Judge + Embedding 并行后的端到端 P50 / P95；
- Judge=No 的 Release 延迟；
- Judge=Yes 的完整 Hold 延迟；
- 5～6 秒 Deadline 超时率；
- 2B Evidence Summary usefulness / evidence accuracy；
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

### Post-session 35B / Summary / Generation

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
- Step-Audio-2-mini、GLM-4-Voice 或其他候选在同一 Benchmark 明显更优。

### Realtime Judge 2B → 8B

只有当：

- Search Route Accuracy 不达标；
- missed-search rate 过高；
- Reference Turn 明显干扰 Target 判断；
- 2B 经 Prompt / Eval 优化后仍有明显误判；
- 8B 的质量提升足以抵消延迟与内存成本。

### Post-session 35B 替换

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

- Realtime Judge / Evidence Summary；
- Memory Retrieval；
- Era Retrieval；
- Post-session Agent；
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
| Realtime Judge / Evidence Summary | **`Qwen/Qwen3.5-2B`（第一候选，Pending Spark Eval）** |
| Slow Search | **NeMo Retriever + Nemotron 1B Embedding / Rerank** |
| Post-session Agent / Summary / Generation | **`nvidia/Qwen3.6-35B-A3B-NVFP4`** |

### 备选

| 层 | 备选 |
|---|---|
| Realtime | **Step-Audio-2-mini（第一备选 / Spark 必测）**；GLM-4-Voice 9B（第二备选） |
| Realtime Judge | **`nvidia/Qwen3-8B-FP4`**（2B 对照 / 质量兜底） |
| Retrieval | NVIDIA 当前 Spark/NIM 可用的兼容 Nemotron Embed / Rerank 版本 |
| Post-session Agent | NVIDIA Nemotron 30B 级 Agent / Reasoning 模型 |

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

StepFun Step-Audio-2：

- https://github.com/stepfun-ai/Step-Audio2
- https://huggingface.co/stepfun-ai/Step-Audio-2-mini

项目内部：

- `docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md`
- `docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md`
- `docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`
- `docs/08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`

# 人生采访局 — DGX Spark 大模型选型 v1.2

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
Step-Audio-2-mini（本地第一主测）
官方 vLLM-Omni 路线

本地对照：MiniCPM-o 4.5
云端体验基准：StepAudio 3 Realtime
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

### 第一主测：Step-Audio-2-mini

定位：

> **DGX Spark 本地 Realtime 第一优先候选，也是比赛 StepFun 技术栈的核心语音模型。**

当前结论：

- Step-Audio-2-mini 为开源中文语音模型，8B 级；
- 支持 Audio-to-Audio / Speech-to-Speech 方向；
- 当前 upstream **vLLM-Omni 已原生支持 StepAudio2**；
- 不再把 StepFun 旧版 custom vLLM fork 作为推荐部署路径；
- 推荐优先使用官方 vLLM / vLLM-Omni 技术栈，而不是维护单独 patched vLLM；
- vLLM-Omni 已提供多模态 / Omni 模型部署能力，适合作为当前 Realtime Runtime 基线；
- DGX Spark / GB10 上的完整 Step-Audio-2-mini Realtime 性能仍必须实测，不在文档中提前宣称已验证。

选择原因：

1. **比赛扣题**：StepFun 模型在 DGX Spark 本地真实运行，比仅调用云 API 更有价值；
2. **中文语音适配**：模型本身就是中文语音方向；
3. **模型规模合适**：8B 级更适合 128GB unified memory 单机与其他模型共存；
4. **运行时复杂度下降**：当前优先走 upstream vLLM-Omni，不再依赖 StepFun 自维护 fork；
5. **可形成明确 Benchmark**：本地 Step-Audio-2-mini 对比云端 StepAudio 3 Realtime。

### 本地对照：MiniCPM-o 4.5

MiniCPM-o 4.5 不再作为第一主选，但保留为**本地强对照 / 失败回退候选**。

选择价值：

- 中文端到端语音能力强；
- Full-Duplex / Duplex Omni Mode 路径更明确；
- 支持用户插话、持续监听和实时流式交互；
- 本地部署资料较成熟；
- 如果 Step-Audio-2-mini 在 Spark 上的首音延迟、打断或稳定性不达标，可以快速切换。

### 云端 Gold Baseline：StepAudio 3 Realtime

StepAudio 3 Realtime 当前作为**体验基准线**，而不是本地部署候选。

Benchmark 目标不是要求本地模型完全复现云端服务，而是量化：

- 本地首音延迟与云端基准差距；
- 中文采访自然度；
- interrupt / barge-in；
- 长时间访谈稳定性；
- 情绪 / 副语言理解；
- Tool / Slow Context 注入后的自然衔接。

目标表述：

> **以 StepAudio 3 Realtime 作为云端体验基准，在 DGX Spark 单机上优先验证 Step-Audio-2-mini，争取实现尽可能接近的本地、隐私优先实时采访体验。**

### Step-Audio-2-mini 推荐部署路径

当前推荐：

```text
DGX Spark
   ↓
官方 NVIDIA / CUDA Runtime
   ↓
upstream vLLM
   ↓
vLLM-Omni
   ↓
Step-Audio-2-mini
   ↓
Realtime Speech-to-Speech
```

不再推荐：

```text
普通 vllm-openai
→ 卸载 upstream vLLM
→ 安装 StepFun custom fork
```

旧 custom fork 只作为历史兼容 / 故障排查参考，不作为目标架构。

### 必测风险

即使 vLLM-Omni 已支持 StepAudio2，以下仍必须在真实 DGX Spark 上验证：

- ARM64 / aarch64 镜像与依赖安装；
- GB10 / Blackwell kernel 兼容；
- 模型完整加载；
- Audio → Audio 基础 Smoke；
- Streaming；
- 用户停说 → 首音延迟；
- interrupt / barge-in；
- full-duplex / 半双工实际能力边界；
- 连续 30 分钟访谈稳定性；
- 与 Qwen3.5-2B Judge 并发；
- 与 NeMo Retriever 并发；
- 与后台 35B Agent 同机时的资源竞争；
- 单 Session / 双 Session；
- unified memory 峰值。

### 推荐验证顺序

```text
P0  vLLM-Omni + Step-Audio-2-mini on DGX Spark
    -> model load
    -> Audio-to-Audio smoke

P1  Streaming
    -> first-audio latency
    -> RTF
    -> 30 min stability

P2  Conversation
    -> interruption / barge-in
    -> Chinese interview quality

P3  Slow System concurrency
    -> 2B Judge
    -> Embedding / Retrieval
    -> 5~6s conditional hold

P4  A/B
    -> MiniCPM-o 4.5 local
    -> StepAudio 3 Realtime cloud baseline
```

### 其他备选

#### GLM-4-Voice 9B

仅当 Step-Audio-2-mini 与 MiniCPM-o 4.5 都无法达到 Realtime 要求时进入正式 Benchmark。

#### NVIDIA PersonaPlex

保留为 NVIDIA 原生全双工技术对照，但当前公开模型重点并非中文，因此不作为中文版人生采访局主选。

#### Qwen3-Omni

中文、多模态能力强，但当前完整模型资源成本较高，不作为单台 Spark 的第一 Realtime 候选。

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
→ Step-Audio-2-mini（第一主测）
→ MiniCPM-o 4.5（本地对照）

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
Step-Audio-2-mini
8B 级；完整 Runtime / KV / Audio pipeline 占用待 Spark 实测

MiniCPM-o 4.5（本地对照）
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
- vLLM / **vLLM-Omni** / SGLang / TensorRT-LLM；
- Step-Audio-2-mini / MiniCPM 音频流、Audio Codec / TTS Runtime；
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
| Step-Audio-2-mini Realtime | **第一主测**：先完成单 Session Smoke，再测 2 Session |
| MiniCPM-o Realtime | 本地对照：先测 1，再测 2 个同时活跃 Session |
| Qwen3.5-2B Realtime Judge / Evidence Summary | 先测 1，再测 2 → 4 |
| Classic Retrieval | 2 → 4 |
| Qwen3.6 Post-session Agent | Realtime 活跃时默认不运行；后台先限制 1–2 |
| Story Generation | 后台队列，默认 1 |
| Agentic Retrieval | Future，默认 1 |

---

## 10. 必须执行的 Benchmark

### Realtime Fast

**Step-Audio-2-mini 为第一主测**，MiniCPM-o 4.5 为本地对照，StepAudio 3 Realtime 为云端 Gold Baseline。三者尽量使用同一套采访测试集，避免只比较“能不能跑”。

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

当前默认先测 Step-Audio-2-mini。只有出现以下情况才考虑把 MiniCPM-o 4.5 提升为正式主选：

- Step-Audio-2-mini 在 GB10 / ARM64 无法稳定部署；
- Streaming / 首音延迟不达标；
- interrupt / barge-in 能力不足；
- 中文长访谈效果不达标；
- 与 2B Judge / Retriever 并发后延迟不可接受；
- MiniCPM-o 4.5 在同一 Benchmark 明显更优。

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
| Realtime Fast System | **Step-Audio-2-mini（DGX Spark 第一主测）** |
| Realtime Judge / Evidence Summary | **`Qwen/Qwen3.5-2B`（第一候选，Pending Spark Eval）** |
| Slow Search | **NeMo Retriever + Nemotron 1B Embedding / Rerank** |
| Post-session Agent / Summary / Generation | **`nvidia/Qwen3.6-35B-A3B-NVFP4`** |

### 备选

| 层 | 备选 |
|---|---|
| Realtime | **MiniCPM-o 4.5（本地强对照 / 回退）**；GLM-4-Voice 9B（第二备选） |
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

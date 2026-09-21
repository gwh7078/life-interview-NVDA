# NVIDIA Integration

本目录用于整理 NVIDIA 相关 Runtime、DGX Spark、本地推理、Retriever 与部署资料。

## 当前推荐模型选型

当前 DGX Spark 模型职责划分与候选模型已经形成 v1.0 推荐方案：

- Realtime Fast System：MiniCPM-o 4.5；
- Slow Decision：`nvidia/Qwen3-8B-FP4`；
- Slow Search：NeMo Retriever + Nemotron Embedding / Rerank；
- Slow Execution / Summary：`nvidia/Qwen3.6-35B-A3B-NVFP4`；
- 最终 Production Model 仍需真实 DGX Spark Benchmark 后冻结。

详细设计：

- [DGX Spark 大模型选型 v1.0](MODEL_SELECTION_v1.0.md)

## 当前已经验证

### NemoClaw / OpenShell / OpenClaw

Phase 1 已完成真实本地 Smoke，证明以下链路可运行：

```text
Node AgentGateway
-> NemoClaw
-> OpenClaw
-> Skill
-> Scoped Tool API
-> SQLite-backed Repository
```

历史报告仍保留在：

- `../nvidia-agent-native/PHASE1_LOCAL_SMOKE_RESULT.md`
- `../nvidia-agent-native/PHASE1_IMPLEMENTATION_REPORT.md`

## 当前开发

Phase 2A 已冻结 Backend / Agent Contract。

Phase 2B 正式实现：

- NemoClawAgentTaskAdapter；
- 4 类正式 Agent Task / Skill family；
- Model Router；
- Runtime Error Contract；
- Tracing；
- Agent Eval。

当前主仓库已经存在：

- onboarding-closeout；
- interview-closeout；
- story-completion；
- story-generation。

## DGX Spark

后续目标：

- 在 DGX Spark 运行 Agent Runtime；
- 本地推理；
- 测试 StepFun / NVIDIA / 其他候选模型；
- 记录 P50 / P95 latency；
- 记录 schema success / repair rate；
- 形成可复现部署说明。

Future Retriever 也应在真实 DGX Spark 上单独记录：

- Classic Retrieval P50 / P95；
- Agentic Retrieval P50 / P95；
- recall / evidence quality；
- GPU / unified memory 占用；
- Realtime 与 Deep Search 并发时的资源竞争。

未完成实测前，不承诺具体吞吐或延迟。

## NeMo Retriever

当前延期，不进入 Phase 2A / Phase 2B 第一阶段核心链路。

Future 设计明确区分两档：

### Classic Retrieval

```text
dense / hybrid retrieval
 -> rerank
 -> Top-K evidence
```

用途：

- Realtime Slow System；
- 普通历史 Recall；
- 低延迟 Evidence Search。

原则：

> **Realtime 只使用 Classic Retrieval，不同步等待 Agentic Retrieval。**

### Agentic Retrieval

```text
agent reasoning
 -> multiple retrieval sub-queries
 -> evidence fusion
 -> final evidence selection
```

用途：

- Post-session / Offline Agent；
- 复杂历史冲突核查；
- 跨多个 Session / Story 的 Deep Recall；
- Future Deep Evidence / Generation 辅助搜索。

原则：

> **Agentic Retrieval 作为 Agent Tool 使用，不作为 Realtime Voice 默认检索路径。**

Future Tool 形态：

```text
memory.search
 -> Classic Retrieval

memory.deep_search
 -> Agentic Retrieval
```

两者共用同一个可重建 Transcript Derived Index；SQLite / Transcript 继续是 Source of Truth。

详细设计见：

- `../08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`
- `../08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`

## 文档真实性原则

比赛 README 必须区分：

- **Implemented**
- **Validated**
- **Current Development**
- **Planned / Future**

不能把仅有架构设计但尚未完成的 NVIDIA / DGX Spark / Retriever 能力写成已落地。

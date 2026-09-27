# NVIDIA Integration

本目录用于整理 NVIDIA 相关 Runtime、DGX Spark、本地推理、Retriever 与部署资料。

## 当前 Realtime 状态

- `StepAudio 3 Quality`：默认正式 Realtime profile，通过 StepFun Cloud Realtime API 运行。
- `Step-Audio-2-mini`：第二条正式 profile，当前继续使用 StepFun Cloud；未来 DGX Spark 只替换这一 profile 的执行后端。
- MiniCPM-o Realtime 保留为 **Experimental**，不作为默认 Provider，也不自动回退。
- 双 Profile 与 Independent Memory 的当前实现、验证结果见 [Realtime Dual Profile and Memory Report](../07-reports/testing/REALTIME_DUAL_PROFILE_MEMORY_REPORT_v1.0.md)。

DGX Spark 其他模型职责与部署候选仍见 [模型选型 v1.2](MODEL_SELECTION_v1.0.md)；此处不据此改变当前 Realtime Provider 决策。

上述 NVIDIA `Qwen3.6-35B-A3B-NVFP4` 是 DGX Spark 本地推理候选。当前 Mac/NemoClaw 的 OpenClaw Agent 与文本任务走 Bailian Model Studio API，模型 ID 为 `qwen3.6-35b-a3b`；二者是不同 provider/runtime 的部署配置。当前实时语音与检索路由见 [AI 开发联调环境](../AI开发联调环境.md)。

详细设计：

- [DGX Spark 大模型选型 v1.2](MODEL_SELECTION_v1.0.md)

## NeMo Agent Toolkit

NeMo Agent Toolkit（NAT）用于现有 NemoClaw / OpenClaw Agent Runtime 的：

- Agent Evaluation；
- Regression Test；
- Profiler；
- Trace / Trajectory；
- Benchmark。

当前原则：**NAT 不接管业务 Adapter，也不替换 NemoClaw / OpenClaw Runtime。**

开发前参考：

- [NeMo Agent Toolkit 开发参考资料索引 v1.0](NEMO_AGENT_TOOLKIT_REFERENCE_INDEX_v1.0.md)

该索引包含官方 Installation、Public Plugin API、Custom Evaluator、Profiler、Experimental OpenClaw Adapter、NeMo Relay、ATIF、Observability 等资料。

> NAT-1 已实现并完成六路真实 Smoke；完整状态以 [NeMo Agent Toolkit 接入说明](NEMO_AGENT_TOOLKIT_INTEGRATION_v1.0.md) 和实际测试记录为准。Relay / ATIF / Phoenix 仍属于 Future / Experimental，不能提前写成生产能力。

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
- 5 类正式 Agent Task / Skill family（含 Realtime `interview.context_hint`）；
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

Phase 3 A+B 已完成 Mac 本机真实 Integration Gate：REST ingest/query、MCP query、条件式 Realtime recall、并发隔离、延迟预算和最终 SQLite / Retriever / trace 状态均已通过。Retriever 仍不进入 Phase 1 核心链路；Agentic Retrieval 与 DGX Spark 实机验证继续作为后续工作。

Future 设计明确区分两档：

### Classic Retrieval

```text
dense / hybrid retrieval
 -> rerank
 -> Top-K evidence
```

用途：

- 已实现但仍待真实 Agent / 语音验收的 Current Story Realtime Context Hint；
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

不能把仅有架构设计但尚未完成的 NVIDIA / DGX Spark / Retriever / NAT 能力写成已落地。当前 NAT-1 的
Implemented / Validated 范围以 [接入说明](NEMO_AGENT_TOOLKIT_INTEGRATION_v1.0.md) 为准；Relay、ATIF、Phoenix
仍属于 Future / Experimental。

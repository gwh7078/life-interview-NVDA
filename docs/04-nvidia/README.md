# NVIDIA Integration

本目录用于整理 NVIDIA 相关 Runtime、DGX Spark、本地推理、Retriever 与部署资料。

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

Phase 2A 不继续扩张 NVIDIA Runtime。

当前只冻结 Backend / Agent Contract。

## Phase 2B

将正式实现：

- NemoClawAgentTaskAdapter；
- 4 类 Agent Task / Skills；
- Model Router；
- Runtime Error Contract；
- Tracing；
- Agent Eval。

## DGX Spark

后续目标：

- 在 DGX Spark 运行 Agent Runtime；
- 本地推理；
- 测试 StepFun / NVIDIA / 其他候选模型；
- 记录 P50 / P95 latency；
- 记录 schema success / repair rate；
- 形成可复现部署说明。

## NeMo Retriever

当前延期，不进入 Phase 2A / 2B 第一阶段核心链路。

Future 设计见：

- `../08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`

## 文档真实性原则

比赛 README 必须区分：

- **Implemented**
- **Validated**
- **Current Development**
- **Planned / Future**

不能把仅有架构设计但尚未完成的 NVIDIA / DGX Spark 能力写成已落地。

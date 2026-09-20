# Architecture Evolution v1.0

本文件记录人生采访局 NVIDIA 版架构如何逐步演进。旧方案不删除，因为每次变化都对应一次真实问题识别或开发验证。

## Stage 0 — Stable Web Product Baseline

起点不是空白 Demo，而是已有完整 Web 产品：

```text
Realtime Interview
-> Transcript
-> Closeout
-> Summary / Agent Memory
-> Completion
-> Story Generation
-> Documents / Book
```

这个阶段的重点是产品逻辑与真实用户体验。

相关：

- `docs/product/life-interview-product-tech-data-v1.5.3.md`
- `docs/product/life-interview-acceptance-test-v1.0.md`

## Stage 1 — Agent Runtime Feasibility

目标：先证明 NemoClaw / OpenClaw 不是纸面架构。

完成最小真实链路：

```text
Node AgentGateway
-> NemoClaw
-> OpenClaw
-> Skill
-> Scoped Tool API
-> Repository
-> SQLite
-> structured result
```

这一阶段证明：

- OpenClaw 可以作为 Agent Runtime；
- Agent 无需直接访问 SQLite；
- Tool API 可以做 owner/resource scope；
- Sandbox / policy 可以进入正式架构。

相关：

- `docs/nvidia-agent-native/PHASE1_LOCAL_SMOKE_RESULT.md`
- `docs/nvidia-agent-native/PHASE1_IMPLEMENTATION_REPORT.md`

## Stage 2 — Initial Agent-Native Plan

早期计划倾向：

```text
Web Backend migration
+
Agent Runtime
+
Skills
+
Retriever
+
NVIDIA environment
```

同步推进。

问题：变量太多。产品逻辑、Agent、Runtime、模型、Retriever 和硬件环境同时变化，一旦失败难以归因。

## Stage 3 — Architecture v2.2 Contract-First

当前方案：

```text
Phase 2A
Backend / Agent Contract
-> Stub
-> freeze boundary

Phase 2B
NemoClaw / OpenClaw
-> adapt frozen Contract
```

核心变化：

- 不重新做一次 Legacy Model 闭环；
- 不同步开发 Retriever；
- 不把 Realtime 放入 Agent 主链路；
- 产品层先输出稳定的结构化 Context；
- Agent 后续只负责适配。

相关：

- `ARCHITECTURE_v2.2_task-contract-first.md`
- `../03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## Stage 4 — Future Fast / Slow Realtime

Realtime 未来不变成“每轮都经过复杂 Agent”。

采用：

```text
Fast Realtime
     +
Parallel Slow System
```

Slow System 可以调用 Retriever / Memory Search，但不阻塞当前语音轮次。

相关：

- `../08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`

## Stage 5 — Future Retriever

Retriever 定位从“业务核心存储”明确收敛为：

> Derived Search Index

SQLite 保持 Source of Truth。

相关：

- `../08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`

## 演进原则

每一次架构调整都遵循：

1. 产品逻辑优先稳定；
2. Agent 只承担非确定性任务；
3. Runtime 可替换；
4. Model 可替换；
5. 数据 Source of Truth 不依赖 Agent；
6. Future 能力不提前污染当前开发范围；
7. 旧文档保留，让变化原因可追溯。

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

重点是产品逻辑与真实用户体验。

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

早期计划倾向同时推进：

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

问题是变量太多，一旦失败难以归因。

## Stage 3 — Architecture v2.2 Contract-First

Phase 2A 采用：

```text
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
- 产品层先输出稳定结构化 Context；
- Agent 后续只负责适配。

相关：

- `ARCHITECTURE_v2.2_task-contract-first.md`
- `../03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## Stage 4 — Architecture v2.3 低轮次 Agent 执行

Phase 2B 开始后进一步冻结执行策略：

```text
固定业务路由
→ Backend

固定上下文
→ Backend 预取

非确定性推理
→ Agent

专项工作方法
→ Skill

运行时额外信息
→ Tool

最终 Proposal
→ Backend Validate / Apply
```

这一阶段明确放弃两类“伪 Agent 化”：

1. 不增加没有业务意义的总控 Agent；
2. 不让 Agent 为固定数据重复调用 Context Tool。

同时明确：

- Skill 优先于新增 Agent；
- Memory Search 只在运行时确有必要时条件触发；
- 正常任务目标为 1 次 Agent Run；
- 复杂任务尽量在同一个 Agent Run 内完成 Tool Loop；
- 最终结果严格结构化；
- 纯格式失败才进入强制 JSON / JSON Schema 修复；
- Runtime Retry、Validation Repair、Format Repair 必须区分。

相关：

- `ARCHITECTURE_v2.3_agent-execution-efficiency.md`
- `../03-agent/AGENT_EXECUTION_POLICY_v1.0.md`

## Stage 5 — Future Fast / Slow Realtime

Realtime 未来不变成“每轮都经过复杂 Agent”。

采用：

```text
Fast Realtime
     +
Parallel Slow System
```

Slow System 可以条件式调用 Retriever / Memory Search，但不阻塞当前语音轮次。

相关：

- `../08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`

## Stage 6 — Future Retriever

Retriever 定位从“业务核心存储”收敛为：

> Derived Search Index

SQLite 保持 Source of Truth。

Retriever 未来首先作为**条件式历史补充工具**，而不是每次 Closeout 的固定前处理。

相关：

- `../08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`

## 演进原则

1. 产品逻辑优先稳定；
2. Agent 只承担非确定性任务；
3. 固定流程不为 Agent 化而 Agent 化；
4. 固定 Context 优先预取；
5. Skill 优先于新 Agent；
6. Tool 只解决运行时增量信息；
7. Runtime 可替换；
8. Model 可替换；
9. SQLite 不依赖 Agent；
10. Future 能力不提前污染当前开发范围；
11. 旧文档保留，让变化原因可追溯。

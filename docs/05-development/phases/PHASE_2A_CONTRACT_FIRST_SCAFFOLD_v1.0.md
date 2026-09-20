# Phase 2A — Contract-First Scaffold v1.0

> Status: **Current Development Phase**
>
> Goal: 做好 Agent 外部接口，不要求真实 Agent / Model 闭环。

## 1. 为什么不重新做完整模型闭环

原 Web 版本已经证明完整产品链路能够工作。当前 NVIDIA 版本最重要的问题不是再次验证 Transcript → Model → DB，而是先确保 Backend → Agent Contract → Future Agent Result 的接口设计正确。

因此 Phase 2A 允许 Web 处于“Agent 尚未接入”的半成品状态。

## 2. 本阶段必须实现

建议新增：

```text
src/agent-tasks/
├── contracts/
│   ├── common.ts
│   ├── onboarding-closeout.ts
│   ├── interview-closeout.ts
│   ├── story-completion.ts
│   └── story-generation.ts
├── definitions/
│   └── task-definition-registry.ts
├── ports/
│   └── agent-task-port.ts
├── adapters/
│   └── stub-agent-task-adapter.ts
└── errors.ts
```

完成：

- 4 个 Task Type；
- interview.closeout 的 3 个 mode；
- Input / Output Schema；
- AgentTaskRequest / Result；
- AgentTaskPort；
- TaskDefinitionRegistry；
- Context → Task Request mapping；
- Stub Adapter；
- Contract / Interface Tests。

## 3. 本阶段明确不实现

```text
LegacyDirectAdapter
真实模型调用
NemoClawAgentTaskAdapter
OpenClaw Skills
完整 Agent Retry / Repair
Agent Benchmark
Realtime Agent
Realtime Slow System
NeMo Retriever 产品集成
Memory Search
```

已有 Phase 1 NemoClaw / OpenClaw Smoke 代码继续保留。

## 4. ContextBuilder

当前已有 ContextBuilder 尽量保留。Phase 2A 在它们与 AgentTaskPort 之间增加稳定映射，不进行大范围目录搬迁。

目标：

> 最小重构面积，最大契约清晰度。

## 5. Prompt Builder

当前 Prompt Builder 暂时保留，但新的 Agent Contract 不依赖 Prompt 字符串。

未来 Phase 2B：

```text
Structured Context
       ->
OpenClaw Skill
       ->
Prompt / Reasoning
       ->
Model
```

即 Prompt / Working Method 最终属于 Skill。

## 6. Stub Adapter

Stub 只返回符合 Schema 的固定结果，不模拟智能。

用途：

- 验证 Task 路由；
- 验证 Input / Output Contract；
- 验证 Backend 可以正确接 AgentTaskResult。

建议开发配置：

```text
AI_TASK_RUNTIME=stub
```

## 7. 测试范围

Contract Tests 至少覆盖 Task Type、mode、required fields、strict schema、长度限制、source/evidence ID、contributor summary 400 字限制、gaps 最大 3 条与 generation output 非空。

Interface Tests 验证：

```text
ContextBuilder
  ->
AgentTaskRequest
  ->
Stub
  ->
AgentTaskResult
  ->
Backend parser
```

不要求完整产品 E2E。

## 8. Definition of Done

- [ ] 4 个 Task Contract 完成
- [ ] interview.closeout 三种 mode 完成
- [ ] Input / Output Schema 冻结
- [ ] AgentTaskPort 完成
- [ ] TaskDefinitionRegistry 完成
- [ ] Context → Request mapping 完成
- [ ] Stub Adapter 完成
- [ ] Contract Tests 通过
- [ ] Interface Tests 通过
- [ ] Public API 无破坏性变化
- [ ] Realtime 未修改
- [ ] Retriever 未接入

满足后：

> **Web / Backend Agent Boundary Frozen**

然后停止继续扩展产品侧 Agent 化，进入 Phase 2B。

## 9. Phase 2B 入口约束

- Agent 适配 Contract；
- 不反过来要求产品修改 Contract；
- 不直接访问 SQLite；
- 不绕过 Validator / Applier；
- 不把 Realtime 放进 OpenClaw 主链路；
- 不顺手开发 Retriever；
- Contract 变更必须版本化。

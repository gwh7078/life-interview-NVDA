# Phase 2B — Agent Runtime Integration v1.0

> Status: **In Progress**
>
> Start date: 2026-09-20
>
> Contract baseline: `docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`
>
> Execution baseline: `docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md`

## 1. Goal

让 NemoClaw / OpenClaw 适配已经冻结的 Phase 2A Agent Task Contract，并实现低轮次、可重试、可追踪的正式 Agent Runtime。

Phase 2B 不重新设计产品 API 或 Domain Rule。

## 2. 已冻结的执行原则

- 固定 Task 路由由 Backend 决定；
- 固定 Context 由 Backend 预取；
- Agent 默认一次运行完成任务；
- 同一职责内优先使用 Skill，不为小功能新增 Agent；
- Tool 只用于运行时才能判断是否需要的额外信息；
- Agent 返回 Proposal，Backend 自动 Validate / Apply；
- 正常首次执行保留 Tool Calling；
- 纯格式错误才用强制 JSON / JSON Schema 做 Format Repair；
- Runtime Retry、Validation Repair、Format Repair 分开处理；
- 正式 Agent 模式不隐式 fallback 到 Legacy。

## 3. Work streams

### 2B-1 — Product-side Agent adapter

`NemoClawAgentTaskAdapter` 已实现：

- 校验 AgentTaskRequest envelope；
- 解析 TaskDefinition；
- 校验 mode-specific payload；
- 确定性路由 Skill + Model Profile；
- 调用 AgentTaskExecutor；
- 校验 Agent output；
- 返回带 runtime metadata 的 AgentTaskResult。

### 2B-2 — Formal Skills

已提交：

```text
agent/skills/
├── onboarding-closeout/
├── interview-closeout/
│   └── references/
│       ├── story-create.md
│       ├── story-continue.md
│       └── contributor.md
├── story-completion/
└── story-generation/
```

下一步在不改变 Task Contract 的前提下，根据真实 E2E 再优化 Skill。

未来若增加 Story Discovery / Memory Reconcile，优先作为 Interview Closeout Agent 的辅助 Skill，而不是默认新增独立 Agent。

### 2B-3 — Structured Context Transport

**已实现并冻结。**

固定 Context 仍由 Backend ContextBuilder 预取并放入 `AgentTaskRequest.payload`。

Runtime 不让 Agent 再调用 Context Tool，而是在 Agent 开始 reasoning 前构造完整 Task Prompt，并通过：

```text
OpenClaw --message-file -
        ^
        |
      stdin
```

把固定 Context 注入当前 Agent Run。

因此：

- Transcript / payload 不进入 CLI 参数；
- 不暴露在 process listing；
- 不需要 `get_task_context` Agent Tool；
- 不计入 `tool_call_count`；
- 正常 Task 可以保持 `1 Agent Run / 0 Dynamic Tool Call`；
- OpenClaw 的正常 Tool Loop 能力仍保留给 Future 动态 Tool。

当前实现对单次 stdin Prompt 设置 4 MiB 上限，与 OpenClaw message-file 边界一致。

### 2B-4 — NemoClaw/OpenClaw Executor

正式路径：

```text
Backend ContextBuilder
 -> AgentTaskRequest
 -> NemoClawAgentTaskAdapter
 -> AgentTaskExecutor
 -> NemoClaw / OpenShell
 -> OpenClaw
 -> registered Skill
 -> model
 -> LIFE_INTERVIEW_RESULT
 -> Backend Validate / Apply
```

正常 Task 不要求 Agent 再调用 Context Tool，也不要求 Agent 再调用 Submit Tool。

### 2B-5 — Retry / Repair / Tracing

统一由 AgentTaskExecutor 管理。

当前已实现：

- Task Executor 与单次 Attempt Runner 分层；
- Runtime Retry；
- Final Result 缺失 / JSON 解析失败 / Output Schema 失败后的 Format Repair attempt；
- maxAttempts 由 TaskDefinition.executionPolicy 控制，当前默认最多 3 次；
- tracing 记录 attempt / repair / tool call / format repair / skill / provider / model / context / schema / input-output hash。

尚未完成：

- Backend Business Validator Feedback → Validation Repair 的正式闭环；
- provider / model API 层的强制 JSON / JSON Schema 参数级 Format Repair。

至少区分：

#### Runtime Retry

timeout / runtime unavailable / network/provider error。

保持 Tool Calling，正常重跑。

#### Validation Repair

业务 Validator 失败，把明确反馈传给 Agent 修正 Proposal。

#### Format Repair

最终 `LIFE_INTERVIEW_RESULT` 缺失、JSON 无法解析或纯结构化失败。

此时可以在模型/API 参数层强制 JSON / JSON Schema。

禁止把所有失败都通过“强制 JSON”掩盖。

Tracing 增加：

- attempt_count；
- repair_count；
- tool_call_count；
- format_repair_used；
- model / provider；
- latency；
- error_code。

### 2B-6 — Tool Strategy

当前 Phase 2B 核心 4 Task 不依赖 Memory Search。

Future Tool 接入原则已经冻结：

- 只用于运行时额外信息；
- 不按数据库表拆 CRUD；
- 优先任务级、问题级能力；
- scoped token + owner/resource/run scope；
- Agent 不直接访问 SQLite；
- 正常任务 0 Tool Call；
- 普通历史疑点优先使用 `memory_search` / Classic Retrieval；
- 真正复杂跨历史问题才升级 `memory_deep_search` / Agentic Retrieval；
- Realtime Slow Agent 只允许 Classic Retrieval，不允许 Agentic Retrieval 阻塞语音。

Future：

```text
memory_search
 -> Classic Retrieval
 -> low-latency recall

memory_deep_search
 -> Agentic Retrieval
 -> post-session / offline deep evidence search
```

当前只保留 Runtime 对 Tool Loop 的兼容性，不在 Phase 2B 核心路径实现这两个 Tool。

## 4. Explicitly out of scope

当前仍不开发：

- Realtime Agentization；
- Realtime Slow System；
- NeMo Retriever 正式产品集成；
- Classic Memory Search 正式产品调用；
- Agentic Retrieval 正式产品调用；
- 外部世界事实核查；
- public API redesign。

但需要为后续条件式 Tool Calling 保留 Runtime 能力，不能把 Agent Executor 设计成“永远只能单次直接 JSON 输出”的简单模型代理。

## 5. Phase 1 compatibility

既有 `story-context-inspector` Phase 1 Smoke Skill 与 `NemoClawOpenClawGateway` 必须继续可复现。

Phase 2B 新增正式路径，不改写历史 Smoke 证据。

## 6. Definition of Done

- [x] NemoClawAgentTaskAdapter verified
- [x] 4 formal Skill families committed
- [x] structured context transport frozen and tested
- [x] NemoClaw/OpenClaw task executor implemented
- [ ] all four Task families return schema-valid results through real Agent runtime
- [ ] retry/repair policy implemented
- [ ] format-repair 强制 JSON 兜底实现并测试
- [x] tracing records task/skill/model/runtime/attempt/tool metadata
- [ ] Agent E2E report written
- [x] normal task runtime path is covered by deterministic test as zero dynamic Tool Call
- [x] no Realtime / Retriever scope creep

# Agent Runtime

> 当前 Agent Task / Skill / Runtime 真相源，更新于 2026-09-27。

## 1. Task Registry

当前正式 Task：

```text
onboarding.closeout

interview.closeout
├─ story_create
├─ story_continue
└─ contributor

interview.context_hint

story.completion

story.generation
```

固定业务入口由 Backend 决定，不增加总控 Agent 重新判断已知路由。

## 2. Skill

当前产品 Skill family：

- `onboarding-closeout`
- `interview-closeout`
- `interview-observer`
- `interview-coach`
- `story-completion`
- `story-generation`

`story-context-inspector` 属于早期 Smoke / 诊断，不计入当前产品能力。

## 3. Runtime

`AgentTaskPort` 支持：

```text
Direct Model Runtime
NemoClaw / OpenClaw Agent Runtime
Stub Runtime
```

`.env.example` 当前默认：

```text
AI_TASK_RUNTIME=direct
```

所以正确表述是：

> Agent Runtime 已实现并经过专项真实验证，但当前 Web 默认环境仍使用 Direct Model；需要时可切换到 NemoClaw / OpenClaw。

## 4. Contract

Agent 输入和输出必须稳定结构化：

```text
Context Builder
→ AgentTaskRequest
→ Runtime
→ Proposal
→ Schema Validation
→ Evidence Validation
→ Domain Validation
→ Apply
```

Agent 不能直接写业务 SQLite。

Reasoning 可以重试；Apply 必须保持幂等和事务边界。

## 5. Tool / Script

固定上下文由 Backend 预取，不让 Agent 为“搬数据”产生额外 Tool Round Trip。

只有运行过程中才能判断是否需要的增量信息才允许 Tool / Script。

当前 Story Continue Closeout 可使用受限 `memory-search` script capability。

## 6. interview.context_hint

这是专用 Realtime Context Agent Task：

- agent id：`realtime-context`；
- thinking：off；
- max attempts：1；
- timeout：4,800 ms；
- no script capability；
- no format/validation repair。

它主要服务 StepAudio 3 的 Voice Tool Slow Path。

**Step-Audio-2-mini 的 supervisor_auto Coach 不调用该 Agent。** Mini 使用正式 `interview-coach` Skill，由独立的低延迟 Realtime Runtime 执行 Qwen3-8B Gate / Retrieval / Resolve，避免再叠一层 OpenClaw 调用。

`interview-coach` 与通用 AgentTaskPort Skill 的区别只在 Runtime：它仍是正式 Skill，但默认执行 Runtime 是产品自建的 low-latency realtime runtime，而不是 Direct Model / NemoClaw / OpenClaw。

## 7. Model Profile

Task Definition 当前按职责映射：

- reasoning；
- reasoning-fast；
- realtime-context；
- writing。

Mac 当前 Agent / 文本任务通过 Bailian `qwen3.6-35b-a3b` 配置；未来 Spark 可以替换模型执行后端，不改变 Task Contract。

## 8. NAT

NeMo Agent Toolkit 用于：

- Evaluation；
- Regression；
- Profiler；
- Trace / Trajectory；
- Benchmark。

NAT 不接管 `AgentTaskPort`，也不编排产品流程。

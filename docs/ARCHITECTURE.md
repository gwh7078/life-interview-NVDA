# Architecture

> 当前整体架构，更新于 2026-09-27。  
> Realtime 细节见 [REALTIME.md](REALTIME.md)，Agent 细节见 [AGENT_RUNTIME.md](AGENT_RUNTIME.md)。

## 1. 核心原则

人生采访局不追求“所有东西都 Agent 化”。

```text
Agent / Model = Reasoning Authority
Backend       = Execution Authority
SQLite        = Business Source of Truth
Retriever     = Rebuildable Derived Index
```

固定业务流程由 Backend 决定；语义理解、判断、整理、写作交给模型。Agent 输出是 Proposal，最终落库仍经过 Backend Validation / Transaction / Idempotency。

## 2. 系统结构

```text
Browser
  |
  v
Node Backend
├─ Auth / API / WebSocket
├─ Interview Session
├─ Story / Life Stage / Share / Book
├─ Context Builder
├─ Validator / Applier
├─ SQLite
├─ Realtime Voice
│  ├─ Provider Adapter
│  ├─ Mini Coach
│  ├─ Slow Context / Tool Cycle
│  └─ Observability
├─ Agent Task Port
│  ├─ Direct Model Runtime
│  └─ NemoClawAgentTaskAdapter
└─ Retrieval
   ├─ Private Transcript Index
   └─ Public Era Context Index
```

## 3. Backend 与 Agent 边界

Backend 保留：

- Auth / owner scope；
- Session 生命周期；
- Story / Life Stage / Share / Document / Book；
- SQLite / Repository；
- Transaction / Idempotency；
- resource version / stale protection；
- Schema Validation；
- Evidence Validation；
- Domain Apply；
- 固定 Task 路由。

模型 / Agent 负责：

- Transcript 语义理解；
- Closeout 提案；
- Memory 更新建议；
- Completion / gaps；
- Story Generation；
- Realtime Coach Gate / Resolve；
- 必要的 Context Hint。

## 4. Realtime 是独立低延迟子系统

Realtime 不走一个统一“总控 Agent”。

Mini 当前默认：

```text
Voice Model
 + Qwen3-8B Coach
 + conditional Current Story Retrieval
 + conditional Era Retrieval
```

StepAudio 3 当前保留 Voice Tool → Context Hint 路线。

两条路径共享证据边界与后端生命周期，但执行协议不同。

## 5. Agent Task Runtime

会后 Task 通过稳定 Contract 进入 `AgentTaskPort`。

```text
Product Context
→ AgentTaskRequest
→ AgentTaskPort
   ├─ Direct Model
   └─ NemoClawAgentTaskAdapter
→ Structured Proposal
→ Validator
→ Apply
→ SQLite
```

当前环境模板仍默认 Direct；NemoClaw/OpenClaw 是可切换正式 Runtime，不应与默认配置混为一谈。

## 6. Retrieval

### Private Transcript Index

SQLite Transcript 持久化成功后，Retriever 可以异步建立可重建索引。

Realtime Memory 只能在严格 scope 下访问：

```text
owner
+ current story
+ subject
+ Q+A evidence
```

### Public Era Context

时代背景使用独立 collection，不与用户 Transcript 混存。

```text
narrow year window
+ semantic query
→ public background candidates
→ bounded evidence
→ Coach Resolve
```

Era Evidence 只能影响采访方向，不能进入用户事实链。

## 7. Observability

Observability 是 side channel，不编排业务：

- Realtime trace；
- SSE Tech Observer；
- Competition panel；
- Agent timing；
- NAT Eval / Profiler。

技术观测失败不得影响用户采访。

## 8. 不再采用的架构

已被取代：

- 每轮固定 Qwen3.5-2B Judge；
- Independent Memory 作为 Mini 主慢系统；
- “Retriever 未来再接”；
- “Realtime 当前不 Agent 化”；
- 为比赛增加无业务意义的总控 Agent；
- 让 Agent 直接修改 SQLite。

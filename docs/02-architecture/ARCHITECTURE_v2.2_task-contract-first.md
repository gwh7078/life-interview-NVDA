# Architecture v2.2 — Task-Contract-First Agent-Native Architecture

> Status: **Current / Frozen for Phase 2A implementation**
>
> Date: 2026-09-20

## 1. 为什么出现 v2.2

已有 Web 版本已经实现完整产品能力，包括首次建档、Story 采访、Closeout、Story Agent Memory、Completion、第三者补充、Story Generation 与文档版本。

NVIDIA 版早期已经完成真实的 NemoClaw / OpenClaw 最小 Runtime Smoke。下一步如果同时修改 Web / Backend、Agent Contract、OpenClaw Skills、NemoClaw Runtime、模型与 Retriever，一旦失败很难定位问题属于哪一层。

因此 v2.2 采用：

> **先冻结 Backend → Agent 的 Task Contract，再让 Agent Runtime 适配。**

Phase 2A 允许是“半成品 Web”，不要求重新接真实模型形成完整业务闭环。

## 2. 核心架构

```text
Web / Future Mini Program
          |
          v
Life Interview Backend
  - Public API / Auth / WebSocket
  - Session / Story / Life Stage
  - Repository / SQLite
  - Transaction / Idempotency
  - Validator / Applier
          |
          v
Context Builder
          |
          v
AgentTaskRequest
          |
          v
AgentTaskPort
       /        \
Phase 2A        Phase 2B
 Stub             NemoClawAgentTaskAdapter
                    |
                    v
                 NemoClaw
                 OpenShell
                 OpenClaw
                 Skills
                    |
                    v
                Model Router
```

## 3. 不把整个 Backend Agent 化

以下能力继续属于确定性程序：

- API、Auth、WebSocket；
- Session 生命周期；
- Story / Life Stage / Share / Document / Book；
- SQLite 与 Repository；
- Owner Scope；
- Transaction；
- Lease / stale-attempt protection；
- Idempotency；
- Schema Validation；
- Evidence Validation；
- Domain Apply。

Agent 只处理：

- Transcript 理解；
- 信息归纳与纠正；
- Story Agent Memory 更新建议；
- Story 完整度判断；
- 下一轮 gaps 规划；
- Story 写作。

## 4. 两个 Authority

### Agent = Reasoning Authority

Agent 负责提出应该如何理解、整理、规划与写作。

### Backend = Execution Authority

Agent 的结果统一视为 **Proposal**：

```text
Structured Context
       |
       v
Agent Proposal
       |
       v
Schema Validation
       |
       v
Business / Evidence Validation
       |
       v
Domain Apply
       |
       v
SQLite
```

Agent 不拥有数据库执行权。

## 5. 当前四个 Agent Task

```text
onboarding.closeout

interview.closeout
  - story_create
  - story_continue
  - contributor

story.completion

story.generation
```

详细字段见 `docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`。

## 6. Context Policy

### onboarding.closeout

输入当前 Profile 和所有已结束的 Onboarding Transcript。Profile 是辅助上下文，不自动成为证据。

### interview.closeout / story_create

输入 Target Life Stage、可选标题、Other Story 简要信息、本轮完整 Transcript。

### interview.closeout / story_continue

输入当前 Story Summary、Agent Memory、Life Stage、Other Story 简要信息和本轮完整 Transcript。

明确不输入当前 Story 的历史全部 Transcript。历史采访通过 Story Agent Memory 延续。

### interview.closeout / contributor

只输入 relationship、previous contributor summary、本轮 Transcript。原则上不给 Story Summary、Story Agent Memory、Gaps、主人公历史 Transcript。

### story.completion

只输入 title、Agent Memory、stage、status、previous gaps、blocked directions、session count。不输入 Transcript 与 Story Summary。

### story.generation

首次生成读取 Profile brief、Life Stage、Story title / summary、Story 全量主人公 Transcript、style 与 instruction。

Revision 读取 Selected Document + 全量 Transcript，不再同时提供 Story Summary。

## 7. Memory 与 Evidence

Story Agent Memory 是长期工作记忆，服务采访与 Completion。

Story Generation 回到原始 Transcript，因为 Memory 不应该成为最终文章的最高事实来源。

```text
Transcript
  >
Story Summary / Selected Document
  >
Background Context
```

## 8. Contributor 隔离

Contributor Summary 属于外部证据来源，不自动修改主人公 Story Summary、Agent Memory、Completion，也不自动进入 Story Generation。

## 9. Phase 2A

Phase 2A 不要求真实 Agent 闭环，只实现：

```text
ContextBuilder
     |
     v
AgentTaskRequest
     |
     v
AgentTaskPort
     |
     v
Stub Adapter
     |
     v
AgentTaskResult
```

验证 Contract、Context 映射和 Output Schema。

## 10. Phase 2B

Phase 2B 才实现 NemoClawAgentTaskAdapter、OpenClaw Skills、Model Router、Retry / Repair、Timeout、Tracing 与 Agent Eval。

原则：

> Agent 适配 Contract，而不是 Backend 适配 Agent。

## 11. 一致性策略

正式 Agent Runtime 使用：

> **At-least-once reasoning + Exactly-once domain apply**

Reasoning 可以重试；Domain Apply 必须通过 attempt ownership、resource version、transaction 与 idempotency 防止重复提交。

## 12. 当前延期能力

当前不开发：

- Realtime Agent 化；
- Realtime Tool Calling；
- NeMo Retriever 产品链路；
- Memory Search。

未来 Realtime 采用 Fast / Slow 双系统；Retriever 作为 Slow System 可选工具。

## 13. 冻结项

Phase 2A 完成后冻结：

- 四个 Task；
- interview.closeout 三种 mode；
- Input / Output Schema；
- Context Policy；
- AgentTaskPort；
- TaskDefinitionRegistry；
- Public API 的 Agent-independent 边界。

后续若需要变更 Contract，应新增版本。

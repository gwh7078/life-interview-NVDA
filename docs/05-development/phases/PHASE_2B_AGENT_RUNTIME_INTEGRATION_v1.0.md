# Phase 2B — Agent Runtime Integration v1.0

> Status: **In Progress**
>
> Start date: 2026-09-20
>
> Contract baseline: `docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## 1. Goal

Adapt NemoClaw / OpenClaw to the frozen Phase 2A Agent Task Contract.

Phase 2B must not redesign product APIs or domain rules.

## 2. Work streams

### 2B-1 — Product-side Agent adapter

`NemoClawAgentTaskAdapter`:

- validates AgentTaskRequest envelope;
- resolves TaskDefinition;
- validates mode-specific payload;
- routes deterministic Skill + Model Profile;
- invokes an injected AgentTaskExecutor;
- validates Agent output against registered schema;
- returns AgentTaskResult with runtime metadata.

The adapter does not own payload transport.

### 2B-2 — Formal Skills

Create:

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

Skills inherit frozen evidence and context boundaries from Contract v1.0.

### 2B-3 — Structured Context Transport

**Implemented in the second slice.**

Large Transcript payloads must not be blindly serialized into command-line arguments.

The next runtime step must choose a transport that:

- preserves Contract v1.0 unchanged;
- is owner/run scoped;
- avoids OS argument length limits;
- does not expose payloads in shell process listings;
- works inside NemoClaw/OpenShell isolation.

Implemented architecture:

```text
Backend / Executor
 -> 0600 temporary run-context file
 -> scoped get_task_context Tool API
 -> OpenClaw Skill
 -> cleanup in executor finally
```

The context filename is derived from a hash of runId rather than containing the raw runId. The file is TTL-bound and is deleted when the task finishes. SQLite remains untouched.

This endpoint is transport, not Agent-selected retrieval.

### 2B-4 — NemoClaw/OpenClaw Executor

After transport is frozen:

```text
NemoClawAgentTaskAdapter
 -> AgentTaskExecutor
 -> NemoClaw / OpenShell
 -> OpenClaw
 -> registered Skill
 -> model
 -> LIFE_INTERVIEW_RESULT
```

### 2B-5 — Retry / Repair / Tracing

Implement after the basic executor works:

- timeout;
- runtime retry;
- schema/business repair;
- cancellation;
- stale result handling;
- agent_runs tracing;
- no implicit Legacy fallback.

## 3. Explicitly out of scope

- Realtime Agentization;
- Realtime Slow System;
- NeMo Retriever product integration;
- Memory Search;
- public API redesign.

## 4. Phase 1 compatibility

The existing `story-context-inspector` Phase 1 smoke Skill and `NemoClawOpenClawGateway` must remain reproducible. Phase 2B adds new runtime paths instead of rewriting historical smoke evidence.

## 5. Definition of Done

- [x] NemoClawAgentTaskAdapter verified
- [x] 4 formal Skill families committed
- [x] structured context transport frozen and tested
- [ ] NemoClaw/OpenClaw task executor implemented
- [ ] all four Task families return schema-valid results through real Agent runtime
- [ ] retry/repair policy implemented
- [ ] tracing records task/skill/model/runtime metadata
- [ ] Agent E2E report written
- [ ] no Realtime or Retriever scope creep

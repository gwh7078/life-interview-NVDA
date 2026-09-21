# Phase 2B-C — Product Runtime Integration & Real E2E v1.0

> Status: **In Progress**
>
> Baseline: Architecture v2.3 + Agent Execution Policy v1.1
>
> Scope: complete the product-side Agent integration before Retriever / Realtime Slow System work.

## 1. Goal

Turn the Agent runtime from a side-path into the formal product execution path without moving deterministic product authority into the Agent.

Formal boundary:

```text
Product Request
 -> Backend ContextBuilder
 -> AgentTaskPort
 -> NemoClaw / OpenClaw
 -> Skill
 -> Model
 -> Proposal
 -> Backend Validator
 -> optional Validation Repair
 -> Backend Applier / Transaction
 -> SQLite
 -> Product Response
```

Backend remains the authority for ownership, lifecycle, validation, stale protection, idempotency and writes.

## 2. Product paths

Phase 2B-C integrates these six execution paths:

1. `onboarding.closeout`
2. `interview.closeout / story_create`
3. `interview.closeout / story_continue`
4. `interview.closeout / contributor`
5. `story.completion`
6. `story.generation`

`AI_TASK_RUNTIME=direct` keeps the legacy direct-model path for regression comparison.

`AI_TASK_RUNTIME=agent` routes product AI tasks through one shared `AgentTaskPort`.

## 3. Retry / Repair policy

One logical Agent Task has a total budget of at most 3 attempts.

The budget is shared by:

- normal execution;
- Runtime Retry;
- Validation Repair;
- Format Repair.

### Runtime Retry

Only runtime/provider execution failures are retried.

Cancellation is terminal and is not retried.

### Validation Repair

Used when the Proposal is valid JSON but fails registered Schema or deterministic Backend business validation.

Backend sends compact structured feedback:

```json
{
  "code": "INVALID_SOURCE_MESSAGE_IDS",
  "path": "current_story.source_message_ids",
  "instruction": "只引用当前 Transcript 中 role=user 的 message_id。"
}
```

The Agent receives the same fixed Context plus repair feedback.

### Format Repair

Only for final result protocol / JSON failures such as:

- missing `LIFE_INTERVIEW_RESULT`;
- invalid JSON;
- non-object final result.

Business validation failures are not classified as Format Repair.

## 4. Cancellation

`AbortSignal` now flows through:

```text
Workflow
 -> AgentTaskPort
 -> AgentTaskExecutor
 -> AttemptRunner
 -> CommandRunner
 -> child process
```

A cancelled task terminates the NemoClaw child process and consumes no additional retry attempt.

Existing Workflow lease / processing_attempt_id / stale guards remain unchanged.

## 5. Resource Version

Agent tracing now records the resource version used to build the Proposal.

Current semantics:

- Story Continue: Story ID + Story updatedAt;
- Story Completion: Story ID + sourceUpdatedAt when present;
- Story Generation: Story ID + Story updatedAt;
- Contributor: Story Share ID + Share updatedAt;
- Story Create / Onboarding: Session resource.

Generation additionally rechecks Story updatedAt before document persistence. If the Story changes during generation, the stale document is rejected.

## 6. Skill Script policy

Current Phase 2B-C tasks authorize no retrieval scripts:

```text
scriptCapabilities = []
```

Future dynamic retrieval follows the current repository policy:

```text
Skill
 -> restricted OpenClaw exec
 -> skills/<skill>/scripts/*
 -> local retrieval service
```

Do not reintroduce dedicated `memory_search` / `get_task_context` Product Tools for normal fixed Context.

Retriever and Realtime Slow System remain deferred.

## 7. Runtime configuration

Formal runtime selection:

```env
AI_TASK_RUNTIME=direct   # legacy product path
AI_TASK_RUNTIME=stub     # deterministic contract/interface testing
AI_TASK_RUNTIME=agent    # NemoClaw/OpenClaw product path
```

Phase 2B model profiles:

```env
NEMOCLAW_SANDBOX=life-interview-agent
AGENT_PROVIDER=
AGENT_MODEL_DEFAULT=
AGENT_MODEL_REASONING=
AGENT_MODEL_REASONING_FAST=
AGENT_MODEL_WRITING=
```

For the first real E2E, all profiles may intentionally point to the same model. Model specialization should be benchmarked only after the runtime path is stable.

## 8. Deterministic verification

Required before real runtime testing:

```bash
npm run typecheck
npm test
```

Coverage includes:

- Task Contract;
- schemaVersion mismatch rejection;
- Runtime Retry;
- Validation Repair;
- Format Repair;
- cancellation;
- Agent tracing;
- product Agent processors;
- Generation stale protection;
- existing product regressions.

## 9. Real six-path E2E Gate

Run on a machine where NemoClaw/OpenClaw and the configured model are available:

```bash
npm run test:agent:real
```

The gate runs all six paths sequentially through the formal `AgentTaskPort`.

Expected final output:

```text
PASS onboarding.closeout
PASS interview.closeout/story_create
PASS interview.closeout/story_continue
PASS interview.closeout/contributor
PASS story.completion
PASS story.generation
LIFE_INTERVIEW_PHASE2B_E2E_REPORT {...}
```

The command exits non-zero when any path fails.

The report records:

- task/mode;
- pass/fail;
- latency;
- runtime metadata;
- Proposal or error;
- selected provider/model metadata.

Do not store API keys or Tool credentials in the report.

## 10. Definition of Done

- [x] Product runtime selector supports direct / stub / agent
- [x] Story Closeout wired to AgentTaskPort
- [x] Onboarding Closeout wired to AgentTaskPort
- [x] Contributor Closeout wired to AgentTaskPort
- [x] Story Completion wired to AgentTaskPort
- [x] Story Generation wired to AgentTaskPort
- [x] Validation Repair implemented
- [x] AbortSignal propagated to child process
- [x] schemaVersion mismatch rejected
- [x] Resource Version traced
- [x] Generation stale write rejected
- [x] Skill Script terminology aligned
- [x] deterministic tests cover the runtime bridge
- [x] six-path real E2E command added
- [ ] six-path real NemoClaw/OpenClaw execution passes on the target environment
- [ ] Phase 2B-C real E2E report committed
- [ ] PR merged to main

## 11. Explicitly out of scope

- NeMo Retriever integration;
- `memory_search`;
- `memory_deep_search`;
- Realtime Slow Agent;
- era context retrieval;
- server.ts structural refactor;
- broad P2 storage cleanup.

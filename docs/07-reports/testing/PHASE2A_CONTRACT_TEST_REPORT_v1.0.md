# Phase 2A Contract Test Report v1.0

> Date: 2026-09-20
>
> Branch: `phase2a/agent-task-contracts`
>
> Pull Request: #2
>
> Status: **PASS**

## 1. Scope

Phase 2A intentionally did not connect a real LLM, NemoClaw production adapter, Realtime Agent path, or NeMo Retriever product integration.

The phase goal was to freeze and verify the interface boundary between the deterministic product backend and the future Agent runtime.

Implemented:

- four Agent Task families;
- three `interview.closeout` modes;
- runtime request/result envelopes;
- mode-specific input schemas;
- output schemas;
- TaskDefinitionRegistry;
- AgentTaskPort;
- StubAgentTaskAdapter;
- Context → AgentTaskRequest mappers;
- backend-only evidence/reference maps;
- `AI_TASK_RUNTIME=stub` Phase 2A runtime factory;
- contract and interface tests.

## 2. Task Contract

```text
onboarding.closeout

interview.closeout
  - story_create
  - story_continue
  - contributor

story.completion

story.generation
```

Task definitions map each task/mode to:

- Skill name;
- Model Profile;
- Input Schema;
- Output Schema;
- Context Version;
- Schema Version.

## 3. Context Boundary Verified

Tests specifically verify:

### Onboarding

Raw database message IDs do not enter Agent payload directly. User evidence is represented by prompt-safe aliases such as `source_1`, while the backend retains the alias → real source reference map.

### Story Closeout

Raw message and Life Stage IDs are compacted to aliases (`m1`, `s1`) and retained in backend-only reference maps.

### Contributor

Contributor context does not contain `current_story` or `agent_memory`, preserving the external-evidence isolation decision.

### Completion

Completion receives Agent Memory / gaps context but no Transcript.

### Generation

Generation receives role/text evidence while internal `sessionId` / `messageId` values are removed from the Agent payload.

## 4. Runtime Contract Verification

The Stub Adapter validates:

1. AgentTaskRequest envelope;
2. mode-specific task input schema;
3. stub output against the registered output schema;
4. AgentTaskResult envelope.

A request with `mode=story_create` cannot provide a `contributor` payload and still pass runtime validation.

Phase 2A intentionally accepts only:

```text
AI_TASK_RUNTIME=stub
```

`AI_TASK_RUNTIME=agent` explicitly returns `AGENT_RUNTIME_NOT_IMPLEMENTED` until Phase 2B.

## 5. CI Results

GitHub Actions workflow:

```text
Verify
Run ID: 35508199338
Job: Deterministic verify
```

Result:

| Step | Result |
|---|---|
| Checkout | PASS |
| Node 24.21.0 setup | PASS |
| npm ci | PASS |
| TypeScript typecheck | PASS |
| Full deterministic verification | PASS |
| Final job | PASS |

The deterministic verification executes the repository's complete local automated suite:

```text
npm test
  -> test:fast
  -> test:integration
  -> test:agent

npm run typecheck
```

Real voice/provider E2E is intentionally excluded because Phase 2A does not validate live Agent/model behavior.

## 6. Issues Found During Verification

### Issue 1 — Generation test context shape

Initial contract test supplied a prompt-safe Generation Transcript directly, but the actual `StoryGenerationContext` still carries server-side `sessionId`, `messageId`, and `timestamp`.

Fix:

- test now constructs the real server-side context shape;
- mapper test confirms these internal identifiers are removed from Agent payload.

### Issue 2 — Runtime mode mismatch risk

Initial registry used the full `interview.closeout` discriminated union as every mode's input schema.

Risk:

```text
request.mode = story_create
payload.mode = contributor
```

could pass the generic union validation if runtime type safety were bypassed.

Fix:

- each mode now has its own registered input schema;
- AgentTaskRequest envelope is strictly validated;
- contract test explicitly rejects cross-mode payloads.

## 7. Result

Phase 2A Definition of Done is satisfied.

The backend/Agent boundary is now considered frozen at Contract v1.0 for Phase 2B.

Phase 2B must adapt NemoClaw / OpenClaw to this contract rather than change product APIs or domain rules.

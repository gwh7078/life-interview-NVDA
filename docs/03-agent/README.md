# Agent Documentation

本目录记录 Agent Task、Skills、Runtime 与 Eval。

## Current phase

**Phase 2B — Agent Runtime Integration / In Progress**

Phase 2A 已完成并冻结 Backend / Agent Contract。

Current contract:

- [`contracts/AGENT_TASK_CONTRACTS_v1.0.md`](contracts/AGENT_TASK_CONTRACTS_v1.0.md)

Current Phase 2B plan:

- [`../05-development/phases/PHASE_2B_AGENT_RUNTIME_INTEGRATION_v1.0.md`](../05-development/phases/PHASE_2B_AGENT_RUNTIME_INTEGRATION_v1.0.md)

## Agent Task

```text
onboarding.closeout

interview.closeout
  - story_create
  - story_continue
  - contributor

story.completion

story.generation
```

## Formal Skills

- [`../../agent/skills/onboarding-closeout/SKILL.md`](../../agent/skills/onboarding-closeout/SKILL.md)
- [`../../agent/skills/interview-closeout/SKILL.md`](../../agent/skills/interview-closeout/SKILL.md)
- [`../../agent/skills/story-completion/SKILL.md`](../../agent/skills/story-completion/SKILL.md)
- [`../../agent/skills/story-generation/SKILL.md`](../../agent/skills/story-generation/SKILL.md)

Historical Phase 1 smoke Skill remains at:

- [`../../agent/skills/story-context-inspector/SKILL.md`](../../agent/skills/story-context-inspector/SKILL.md)

## Runtime boundary

```text
Backend ContextBuilder
 -> AgentTaskRequest
 -> AgentTaskPort
 -> NemoClawAgentTaskAdapter
 -> AgentTaskExecutor
 -> NemoClaw / OpenShell
 -> OpenClaw
 -> Skill
 -> Model
```

`NemoClawAgentTaskAdapter` owns Contract validation and deterministic Task → Skill / Model Profile routing.

`AgentTaskExecutor` owns transport and runtime execution.

Agent returns a Proposal. Backend retains Validator / Applier / Transaction authority.

## Transport note

Large Transcript payload transport is intentionally not coupled to the Adapter. Phase 2B will freeze a run-scoped secure transport before wiring the real OpenClaw executor.

## Eval

Phase 2B will add:

- schema success rate;
- evidence accuracy;
- memory information-loss rate;
- repair rate;
- task latency;
- token usage;
- story writing quality;
- model comparison.

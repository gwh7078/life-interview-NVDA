# Agent Documentation

本目录记录 Agent Task、Skills、Runtime 与 Eval。

## 当前状态

当前是 **Phase 2A — Contract-First Scaffold**。

已经冻结：

- 4 个 Task；
- interview.closeout 三种 mode；
- Context Policy；
- AgentTaskRequest / Result；
- Task → Skill / Model Profile 映射原则。

当前主 Contract：

- [`contracts/AGENT_TASK_CONTRACTS_v1.0.md`](contracts/AGENT_TASK_CONTRACTS_v1.0.md)

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

## Future Skills

Phase 2B 计划：

```text
onboarding-closeout/

interview-closeout/
  SKILL.md
  references/
    story-create.md
    story-continue.md
    contributor.md

story-completion/
  SKILL.md

story-generation/
  SKILL.md
```

Skill 负责专业工作方法、Evidence discipline、结构化输出规则和禁止项。

TaskDefinitionRegistry 决定用哪个 Skill；Model Router 决定用哪个模型。

## Runtime Boundary

Agent 不直接访问 SQLite。

未来正式链路：

```text
AgentTaskPort
-> NemoClawAgentTaskAdapter
-> NemoClaw / OpenShell
-> OpenClaw
-> Skill
-> Model
```

Agent 输出 Proposal，Backend 继续负责 Validator / Applier / Transaction。

## Eval

Phase 2B 后逐步增加：

- schema success rate；
- evidence accuracy；
- memory information-loss rate；
- repair rate；
- task latency；
- token usage；
- story writing quality；
- model comparison。

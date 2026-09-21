# Agent Documentation

本目录记录 Agent Task、Skills、Runtime、执行策略与 Eval。

## 当前阶段

**Phase 2B — Agent Runtime Integration / In Progress**

Phase 2A 已完成并冻结 Backend / Agent Contract。

当前 Contract：

- [`contracts/AGENT_TASK_CONTRACTS_v1.0.md`](contracts/AGENT_TASK_CONTRACTS_v1.0.md)

当前 Agent 执行策略：

- [`AGENT_EXECUTION_POLICY_v1.0.md`](AGENT_EXECUTION_POLICY_v1.0.md)
- [`SKILL_SCRIPT_MAPPING_v1.0.md`](SKILL_SCRIPT_MAPPING_v1.0.md) — Skill 内脚本映射与禁止项

当前 Phase 2B 计划：

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

Phase 1 Smoke Skill：

- [`../../agent/skills/story-context-inspector/SKILL.md`](../../agent/skills/story-context-inspector/SKILL.md)

## 当前职责边界

```text
Backend
├── 固定 Task 路由
├── 固定 Context 预取
├── Validator
├── Applier
└── Transaction
        |
        v
AgentTaskRequest
        |
        v
OpenClaw Agent
├── 主 Skill
├── 辅助 Skill
└── Skill 内条件脚本（Future）
        |
        v
Proposal
        |
        v
Backend Validate / Apply
```

### 固定数据

Agent 启动前由 Backend 一次性准备，不让 Agent 再调用 Tool 获取。

### 辅助 Skill

同一职责内优先通过 Skill 扩展，例如 Future：

- `story-discovery`
- `memory-reconcile`

### Tool

只用于运行时额外信息需求。

Future 最重要的是条件式 `memory_search`。

## Runtime Boundary

```text
Backend ContextBuilder
 -> AgentTaskRequest
 -> AgentTaskPort
 -> NemoClawAgentTaskAdapter
 -> AgentTaskExecutor
 -> Attempt Runner
 -> NemoClaw / OpenShell
 -> OpenClaw
 -> Skill
 -> Model
```

固定 Context 的当前传输方式：

```text
AgentTaskRequest.payload
 -> Runtime builds Task Prompt
 -> stdin
 -> OpenClaw --message-file -
 -> Agent reasoning
```

这是 Runtime pre-injection，不是 Agent Tool Call。正常 Task 不需要 `get_task_context`。

`NemoClawAgentTaskAdapter` 负责 Contract 校验和确定性 Task → Skill / Model Profile 路由。

`AgentTaskExecutor` 负责实际 Runtime 执行、Retry / Repair / Timeout / Tracing。

Agent 返回 Proposal；Backend 保留 Validator / Applier / Transaction 权限。

## 输出与 Tool Calling

正常 Agent Loop 可以按 Skill 规则运行授权脚本；当前核心 Task 默认不执行动态脚本。

最终完成时才必须返回：

```text
LIFE_INTERVIEW_RESULT <strict JSON>
```

如果只是最终格式失败，Format Repair 可以在模型/API 参数层强制 JSON / JSON Schema。

不能把强制 JSON 当成所有失败的统一兜底。

## 当前效率目标

- 正常 Task：1 次 Agent Run；
- 正常 Task：0 次 Retrieval Script；
- 特殊历史疑点：尽量仍在同一个 Agent Run 内完成少量 Skill Script 调用；
- Skill 优先于新 Agent；
- 不增加无业务价值的总控 Agent。

## Eval

Phase 2B 后逐步增加：

- schema success rate；
- first-pass success rate；
- evidence accuracy；
- memory information-loss rate；
- repair rate；
- tool-call rate；
- unnecessary tool-call rate；
- format-repair rate；
- task latency；
- token usage；
- story writing quality；
- model comparison。

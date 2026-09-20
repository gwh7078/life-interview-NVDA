# Agent Task Contracts v1.0

> Status: **Current Contract**
>
> Scope: Phase 2A / Phase 2B shared boundary

## 1. 总原则

> Task 决定 Skill；Runtime 决定 Model；Skill 决定工作方法；Schema 决定输出；Backend 决定是否执行。

## 2. AgentTaskRequest

```ts
interface AgentTaskRequest<T> {
  runId: string;
  taskType:
    | 'onboarding.closeout'
    | 'interview.closeout'
    | 'story.completion'
    | 'story.generation';
  mode?: string;
  ownerId: string;
  resource: {
    type: string;
    id: string;
    version?: string;
  };
  schemaVersion: string;
  payload: T;
}
```

`runId`、`ownerId`、resource id/version 主要服务权限、审计、追踪与 stale protection，不代表全部要进入 Model Prompt。

## 3. AgentTaskResult

```ts
interface AgentTaskResult<T> {
  runId: string;
  taskType: AgentTaskType;
  mode?: string;
  schemaVersion: string;
  output: T;
  runtime: {
    runtime: string;
    skill: string;
    skillVersion?: string;
    provider?: string;
    model?: string;
    latencyMs?: number;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
}
```

`output` 来自 Agent / Model；`runtime` 元信息必须由系统填写。

## 4. TaskDefinitionRegistry

统一维护：

```text
taskType
mode
skill
modelProfile
inputSchema
outputSchema
contextVersion
executionPolicy
```

初始映射：

| Task | Mode | Skill | Model Profile |
|---|---|---|---|
| onboarding.closeout | - | onboarding-closeout | reasoning |
| interview.closeout | story_create | interview-closeout | reasoning |
| interview.closeout | story_continue | interview-closeout | reasoning |
| interview.closeout | contributor | interview-closeout | reasoning |
| story.completion | - | story-completion | reasoning-fast |
| story.generation | - | story-generation | writing |

Model Profile 不等于固定模型。

## 5. onboarding.closeout

输入：

- current profile；
- 所有已结束的 onboarding transcript；
- user message source refs。

输出继续复用现有 Onboarding Closeout Schema，核心包括 Profile candidates、Life Stages、Story Seeds 与 source_refs。

所有新增事实必须追溯到 Transcript 用户发言。

## 6. interview.closeout

统一 Skill：`interview-closeout`

### story_create

输入：target stage、可选标题、other story 简要信息、本轮 Transcript。

输出：

```json
{
  "story": {
    "title": "...",
    "summary": "...",
    "agent_memory": "...",
    "source_message_ids": []
  }
}
```

### story_continue

输入：current story title / summary / agent memory、stage、life stages、other stories、本轮 Transcript。

输出：

```json
{
  "current_story": {
    "summary": "...",
    "agent_memory": "...",
    "memory_changes": [],
    "source_message_ids": []
  },
  "new_stories": []
}
```

Memory 变化只允许：

```text
add
correct
refine
merge
remove
```

没有证据不能静默丢失旧 Memory。

### contributor

输入：

```text
relationship
previous_contributor_summary
current transcript
```

输出：

```json
{
  "summary": "..."
}
```

约束：

- summary ≤ 400 中文字符；
- 不直接修改主人公 Story；
- 不把主人公资料用来“纠正”第三者；
- 保留第三者自己的不确定性与纠正。

## 7. story.completion

Agent role：Planner。

输入：

```text
title
agentMemory
stageTitle
currentStatus
previousGaps
blockedDirections
sessionCount
```

输出：

```json
{
  "status": "pending | interviewing | complete",
  "gaps": []
}
```

gaps 为 0–3 条自然问题；Completion 不读 Transcript。

## 8. story.generation

Agent role：Writer。

首次成稿输入 Profile brief、Life Stage、Story title / summary、全量主人公 Transcript、style、user instruction。

Revision 使用 Selected Document + 全量主人公 Transcript，不再同时提供 Story Summary。

Agent 只输出正文：

```json
{
  "content": "..."
}
```

Server 继续拥有 document title、version、binding、source metadata 与 transaction。

## 9. Agent Output Protocol

Phase 2B Runtime 最终结果：

```text
LIFE_INTERVIEW_RESULT {strict JSON}
```

要求必须存在、可解析、通过 Output Schema 和业务 Evidence Validator，结果后不继续输出解释。

## 10. Error Contract

Context / Business：

```text
SESSION_NOT_FOUND
SESSION_NOT_ENDED
TRANSCRIPT_EMPTY
STORY_NOT_FOUND
STORY_NOT_COMPLETE
PROFILE_NOT_FOUND
```

Runtime：

```text
AGENT_RUNTIME_UNAVAILABLE
AGENT_TIMEOUT
AGENT_EXEC_FAILED
AGENT_RESULT_MISSING
AGENT_CANCELLED
```

Proposal Validation：

```text
AGENT_OUTPUT_SCHEMA_INVALID
INVALID_SOURCE_MESSAGE_IDS
INVALID_MEMORY_CHANGE
MEMORY_INFORMATION_LOSS
INVALID_STORY_STAGE
DUPLICATE_STORY
```

Stale / Concurrency：

```text
AGENT_RUN_STALE
RESOURCE_VERSION_CHANGED
ATTEMPT_REPLACED
```

Phase 2A 只冻结语义；Phase 2B 再实现统一 Retry / Repair Executor。

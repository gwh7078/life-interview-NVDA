# Agent Execution Policy v1.0

> Status: **Current**
>
> Scope: Phase 2B and later Agent Runtime
>
> Task Contract: `contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## 1. 总原则

Agent Runtime 必须优先优化“有效推理次数”，而不是追求更多 Agent、更多 Tool Call 或更多轮次。

目标：

```text
正常任务
= 1 Agent Run + 0 Tool Call

需要历史补充的复杂任务
= 1 Agent Run + 少量必要 Tool Call

格式失败
= 在不重新扩展复杂工作流的前提下做结构化修复
```

## 2. 固定流程由 Backend 编排

Task 路由是确定性的：

- `onboarding.closeout`
- `interview.closeout / story_create`
- `interview.closeout / story_continue`
- `interview.closeout / contributor`
- `story.completion`
- `story.generation`

不启动额外 Orchestrator Agent 再做一次路由判断。

## 3. 固定 Context 预取

所有任务开始前就确定需要的数据，由 Backend ContextBuilder 一次准备并放入 payload。

Agent 不应再为了读取同一批固定数据调用通用数据库 Tool。

Tool 的职责是运行时增量信息，而不是固定 Context 搬运。

## 4. Skill 与 Agent

同一职责内的专业方法优先做 Skill。

例如 Interview Closeout 后续可以增加：

- `story-discovery`
- `memory-reconcile`

它们默认仍在同一个 Interview Closeout Agent Run 内使用。

只有当职责、上下文、模型或评测体系明显不同，才拆新 Agent。

## 5. Tool 使用条件

Tool 只在 Agent 推理过程中出现额外信息需求时调用。

未来 Memory Search 典型触发：

1. 明确引用历史信息；
2. 当前陈述与长期记忆冲突；
3. 人物身份无法仅靠当前 Context 确定；
4. 新 Story 与既有 Story 是否重复无法判断；
5. 时间 / 地点 / 人物关系异常；
6. 不补历史信息会显著增加错误 Proposal 风险。

否则不调用。

## 6. Tool 粒度

Tool 面向“Agent 当前需要解决的问题”，不按数据库表设计 CRUD。

如果需要历史搜索，优先一个受限 `memory_search` 能力，并通过：

- run scope；
- owner scope；
- resource scope；
- 短期 token；
- audit log

控制权限。

Agent 不直接访问 SQLite / memoir.db。

## 7. Proposal 与写库

Agent 只返回 Proposal。

正常任务不再让 Agent 主动调用 `submit_xxx` Tool。

Backend 在收到 Proposal 后自动：

```text
Schema Validation
→ Evidence Validation
→ Version / Stale Check
→ Transaction
→ Apply
→ SQLite
```

## 8. Agent Loop 与 Final Result

执行中允许：

```text
reason
→ tool
→ observation
→ reason
→ final
```

最终输出必须是：

```text
LIFE_INTERVIEW_RESULT <JSON>
```

Final Result 后不得继续输出解释。

业务 Schema 只约束最终结果，不应让第一轮模型调用失去 Tool Calling 能力。

## 9. Retry 分类

### 9.1 Runtime Retry

适用：

- timeout；
- runtime unavailable；
- network error；
- provider error。

行为：

- 正常重跑；
- 保持原 Context；
- 保留 Tool Calling；
- 可使用退避。

### 9.2 Validation Repair

适用：

- source ids 非法；
- memory 信息丢失；
- Story stage 非法；
- duplicate story；
- 其他业务 Validator 失败。

行为：

- 把明确的 Validator Feedback 作为 repair input；
- Agent 修正 Proposal；
- 不隐藏错误原因。

建议反馈结构：

```ts
interface AgentRepairFeedback {
  code: string;
  path?: string;
  instruction: string;
}
```

### 9.3 Format Repair

适用：

- `LIFE_INTERVIEW_RESULT` 缺失；
- JSON 无法解析；
- 纯结构化格式错误。

行为：

- 直接进入格式修复；
- 模型/API 参数层开启强制 JSON / JSON Schema；
- 目标只修复最终结果格式；
- 不应无故重新执行昂贵的历史检索。

注意：

> 强制 JSON 是格式失败兜底，不是所有 Retry 的默认策略。

## 10. 最大尝试次数

初始建议：

```text
MAX_AGENT_ATTEMPTS = 3
```

具体 attempt 根据错误类型选择 Runtime Retry / Validation Repair / Format Repair。

Task 级 Retry 只允许一个统一 owner：`AgentTaskExecutor`。

禁止 Backend、OpenClaw、底层模型分别独立做多层重试，避免指数级放大。

## 11. Stale / Concurrency

Agent Run 启动时记录 resource version。

Apply 前必须确认：

```text
current_resource_version
==
run_start_resource_version
```

否则结果视为 stale，不允许写库。

需要时重新构造 Context 并新建 Run。

## 12. Tracing

`agent_runs` 至少记录：

- run_id；
- task_type；
- mode；
- status；
- attempt_count；
- repair_count；
- skill；
- skill_version；
- model；
- provider；
- context_version；
- schema_version；
- latency_ms；
- error_code。

建议额外记录：

- input hash；
- output hash；
- tool_call_count；
- memory_search_used；
- format_repair_used。

不要在 tracing 中重复保存完整 Transcript。

## 13. Eval

后续 Eval 至少关注：

- schema success rate；
- first-pass success rate；
- tool-call rate；
- unnecessary tool-call rate；
- repair rate；
- format-repair rate；
- evidence accuracy；
- memory information-loss rate；
- latency；
- token usage；
- Story writing quality。

比赛展示时应能说明：

> Agent 的自主性不是来自无意义的多轮，而是来自“只在确实需要时才决定调用 Tool”。

## 14. Future Realtime Slow Agent

当前不开发。

未来 Slow Agent 应：

- 旁路观察 Transcript；
- 不阻塞实时语音；
- 条件式 Memory Search；
- 输出短 Context Hint；
- 不写长期 Story Memory；
- 永久 Memory 仍由 Interview Closeout 统一维护。

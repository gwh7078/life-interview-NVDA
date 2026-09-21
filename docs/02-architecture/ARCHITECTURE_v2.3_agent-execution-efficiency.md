# Architecture v2.3 — 低轮次 Agent 执行架构（Future 检索补充版）

> Status: **Current**
>
> Date: 2026-09-20
>
> Supersedes as current recommendation: `ARCHITECTURE_v2.2_task-contract-first.md`
>
> Contract remains unchanged: `docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## 1. 为什么从 v2.2 演进到 v2.3

v2.2 解决的是“先冻结 Backend 与 Agent 的 Task Contract，再让 Runtime 适配”的问题。

Phase 2A 完成后，新的问题变成：

- 是否应该为了体现 Agent 而增加总控 Agent；
- 固定上下文应该让 Agent 自己调用 Tool 读取，还是 Backend 预取；
- Story Discovery / Memory Reconcile 是否应该拆成独立 Agent；
- Memory Search 应该固定执行还是条件触发；
- 最终结构化输出是否会妨碍 Tool Calling；
- Retry 时什么时候应该强制 JSON；
- 如何尽量减少 Agent 调用轮数。

v2.3 的答案是：

> **固定流程确定性执行，固定数据提前注入；Agent 自主性只放在运行时真正存在不确定性的地方。**

## 2. 不增加没有实际意义的总控 Agent

当前业务入口本身是确定的：

```text
onboarding 结束
→ onboarding.closeout

故事新建采访结束
→ interview.closeout / story_create

故事续访结束
→ interview.closeout / story_continue

第三者采访结束
→ interview.closeout / contributor

完整度判断
→ story.completion

用户点击成稿
→ story.generation
```

因此不增加“传记总编 Agent”来重新决定这些固定路由。

原因：

- 增加一次模型调用；
- 增加延迟与 Token；
- 增加错误概率；
- 并没有产生真实业务价值。

顶层 Task 路由继续由 Backend / TaskDefinitionRegistry 决定。

## 3. Agent / Skill / Tool 的职责

### Agent

Agent 是稳定的专业角色，不应按小功能无限拆分。

当前角色可以保持：

- Onboarding Agent；
- Interview Closeout Agent；
- Planner Agent；
- Writer Agent；
- Future Interview Slow Agent。

### Skill

Skill 表示一种专业工作方法。

同一 Agent 内的专项判断优先通过 Skill 扩展，例如：

```text
Interview Closeout Agent
├── interview-closeout
├── story-discovery
└── memory-reconcile
```

Story Discovery 与 Memory Reconcile 默认不拆成独立 Agent。

### Skill Script 与 Runtime exec

对于运行中才发现的**只读外部信息需求**，本项目优先把调用封装成对应 Skill 的 `scripts/*`，而不是给模型注册一组专用 Product Tool Schema。

模型只需要理解：

- 什么时候需要搜索；
- 应该搜索什么；
- 返回 Evidence 应如何用于当前判断。

脚本内部负责：

- run / owner / resource scope；
- 凭据；
- Backend / Retriever endpoint；
- retrieval mode；
- rerank；
- Top-K；
- 来源补全；
- 结果裁剪。

OpenClaw 底层仍可通过受限的通用 `exec` 能力运行脚本，因此 Agent Loop 仍然保留“判断 → 执行 → 观察 → 继续推理”的能力。

Future Retrieval Script：

```text
scripts/memory-search.mjs
 -> Classic Retrieval
 -> 低延迟普通 Recall

scripts/memory-deep-search.mjs
 -> Agentic Retrieval
 -> 高延迟复杂 Deep Evidence Search

scripts/era-context-search.mjs
 -> 时代背景 Classic Retrieval
 -> 只用于采访线索
```

详细映射见 `docs/03-agent/SKILL_SCRIPT_MAPPING_v1.0.md`.

## 4. 固定 Context 在 Agent 启动前由 Backend 预取

例如 `interview.closeout / story_continue` 固定需要：

- current Story title / summary / agent_memory；
- current Life Stage；
- life stages / other stories 的必要摘要；
- current full Transcript。

这些数据在任务开始前已经确定，因此由 ContextBuilder 一次构造并放入 `AgentTaskRequest.payload`。

推荐：

```text
Backend
→ ContextBuilder
→ AgentTaskRequest
→ Agent
→ Proposal
→ Backend Validate / Apply
```

不推荐：

```text
Backend
→ Agent
→ get_context Tool
→ Backend
→ Agent
→ Proposal
```

原则：

> **能预取，不 Tool Call。**

## 5. Agent 不负责固定业务写库

Agent 最终返回 Proposal。

Backend 继续负责：

- Schema Validation；
- Evidence Validation；
- Resource Version Check；
- Lease / stale attempt；
- Idempotency；
- Transaction；
- Domain Apply；
- SQLite persistence。

因此正常 Task 不要求 Agent 再调用一个 `submit_xxx_proposal` Tool。

原则：

> **Agent 输出结果，Backend 自动接管执行。**

## 6. Skill Script 只解决增量信息需求

当 Agent 已经拥有标准 Context 后，只有出现运行时疑点时才考虑执行 Skill Script：

- 用户明确引用以前说过的内容；
- 当前陈述与 Agent Memory 明显冲突；
- 人物代词或身份无法判断；
- 疑似新 Story，但现有 other_stories 摘要不足以判断是否重复；
- 时间线、地点、人物关系出现明显异常；
- Agent 判断如果不补历史证据，继续生成 Proposal 风险过高。

优先级：

```text
Agent Memory 足够
→ 0 Script

普通历史疑点
→ memory-search.mjs
→ Classic Retrieval

Classic Retrieval 仍不足
且任务允许高延迟
→ memory-deep-search.mjs
→ Agentic Retrieval
```

这些 Search 当前仍是 Deferred，不进入 Phase 2B 核心产品依赖。

数据库写入永远不通过 Skill Script。

## 7. Memory Search Script 必须条件触发

未来禁止：

```text
每次 Closeout
→ 固定 Memory Search
→ 再总结
```

正确模式：

```text
标准 Context
↓
Agent 判断
├─ 信息足够
│  → 直接输出
│
├─ 普通疑点
│  → Classic Search
│  → 少量高相关历史证据
│
└─ 复杂跨历史疑点
   → Agentic Deep Search
   → 多步证据搜索
↓
同一个 Agent Run 继续判断
↓
输出
```

目标：

- 正常任务：1 次 Agent Run，0 次 Retrieval Script；
- 普通复杂任务：1 次 Agent Run + 少量 Classic Search Script；
- 极少数深层任务：1 次 Agent Run + 必要 Agentic Search Script；
- 不启动不必要的新 Agent。

## 8. Retrieval 返回必须最小化且可回溯

Search 只解决当前疑点，不负责重新加载全部历史。

返回应尽量小，并带可回溯来源：

```json
{
  "matches": [
    {
      "text": "...",
      "story_id": "...",
      "session_id": "...",
      "message_ids": ["..."],
      "score": 0.82
    }
  ]
}
```

当前 Transcript 是当前直接证据；历史 Search 结果是辅助证据。

如果当前用户明确纠正过去说法：

> 当前明确纠正 > 旧历史陈述。

无论 Classic 还是 Agentic Retrieval，都不能直接写 Story / Memory；仍需进入 Agent Proposal 和 Backend Evidence Validation。

## 9. Skill 优先于新 Agent

### Story Discovery

默认由 Interview Closeout Agent 在当前 Context 内判断。

只有现有 Context 不足时，未来才允许执行受限 Retrieval Script。

### Memory Reconcile

正常的 `add / correct / refine / merge / remove` 由 Interview Closeout Agent 直接处理。

复杂冲突时使用 `memory-reconcile` Skill；只有必要时再动态补历史证据。

只有当一个子任务具有明显不同的目标、上下文、模型、评测标准或独立多轮工作流时，才考虑拆成独立 Agent。

## 10. Agent Loop 与最终结构化输出分离

正常 Agent Run 必须允许：

```text
分析
→ 判断
→ exec Skill Script（可选）
→ Script Result
→ 继续分析
→ Final Result
```

最终结果必须满足：

```text
LIFE_INTERVIEW_RESULT <strict JSON>
```

但不应把“最终结构化”错误地实现成“整个 Agent Loop 从第一步开始就只能立即输出业务 JSON”。

原则：

> **中间允许 Agent 按 Skill 规则执行受限脚本；终止时才强制业务 Schema。**

## 11. 强制 JSON 只作为格式失败兜底

正常第一次执行保留完整 Agent 能力。

只有出现纯格式错误，例如：

- `AGENT_RESULT_MISSING`
- JSON parse failure
- 最终输出无法满足注册 Schema，但语义任务已完成

才进入格式修复：

```text
正常 Agent Run
↓
最终格式失败
↓
Format Repair Retry
↓
模型/API 参数强制 JSON / JSON Schema
↓
重新生成结构化最终结果
```

不能把所有失败都归类为格式问题。

### Runtime / 网络失败

正常重跑，保留 Tool Calling。

### 业务校验失败

把 Validator Feedback 传给 Agent 做 Repair。

### 缺少历史信息

不能禁止必要的 Skill Script 后强迫 JSON；应先补信息。

## 12. Retry 所有权

Task 级 Retry 只由一个统一 `AgentTaskExecutor` 管理，避免 Backend × OpenClaw × Model 多层重试相乘。

推荐最多 3 个 attempt，并按失败类型选择：

- runtime retry；
- validation repair；
- format repair。

Agentic Retrieval 已经完成且证据仍有效时，Format Repair 不应默认重新执行昂贵 Deep Search。

最终一致性仍遵循：

> **At-least-once reasoning + Exactly-once domain apply**

## 13. Realtime Future

Realtime 当前不进入 Phase 2B Agent 主链路。

未来采用：

```text
Realtime Voice Fast System
        +
Parallel Interview Slow Agent
```

Slow Agent 旁路消费 Transcript，条件式执行：

- Story Agent Memory recall；
- `memory-search.mjs` / 个人历史 Classic Retrieval；
- `era-context-search.mjs` / 时代背景 Classic Retrieval（Future）；
- 人物关系识别；
- 时间冲突；
- 新 Story 线索；
- 深挖方向；
- 偏航检测。

硬边界：

> **Realtime Slow Agent 不调用 Agentic Retrieval。**

Slow Agent 只输出短 Context Hint，在安全轮次边界注入 Fast System，不阻塞当前语音轮次。

Future 慢系统的检索来源可以分为：

```text
个人历史召回
 -> “用户以前说过什么”

个人历史事实检索
 -> “人物 / 时间 / 地点 / 关系等历史证据是什么”

时代背景检索
 -> “用户当时生活的年代有什么可能唤起记忆的话题”
 -> 第一版只按年份范围过滤 + 标题/摘要语义检索
 -> 暂不引入地域维度
```

时代背景检索使用独立只读公共资料索引。第一版时代记录只保存开始年份、结束年份、类别、标题和两句摘要；不预存建议问题。Slow Agent 结合当前上下文决定是否使用以及如何形成采访提示，时代背景不得自动进入用户个人事实链路。

详细设计：

- `docs/08-future/retriever/ERA_CONTEXT_LIBRARY_v1.0.md`

**上述 Realtime Slow System 与时代背景检索都仍是 Future / Deferred，当前未实现。**

## 14. Retrieval Depth Routing

Future Retrieval 形成三层长期读取：

```text
L1 Story Agent Memory
 -> 默认工作记忆

L2 Classic Retrieval
 -> memory-search.mjs
 -> 低延迟普通 Evidence Recall
 -> Realtime Slow Agent 可用

L3 Agentic Retrieval
 -> memory-deep-search.mjs
 -> 多查询 / 多跳 / 跨 Session / Story
 -> 仅 Post-session / Offline Deep Evidence Task
```

两种 Retrieval：

- 共用同一 Derived Transcript Index；
- 不改变 SQLite / Transcript 的 Source of Truth 地位；
- 不修改 Task Contract v1.0 的固定输入字段；
- Future 通过版本化 Script Capability / TaskDefinition 决定某 Task 是否允许 Deep Search。

## 15. 事实核查边界

当前不开发复杂的“外部世界事实核查”。

后续若需要，可以先实现低成本的内部 Evidence Check：

```text
Draft
vs
Transcript
```

只检查 Writer 是否写入了用户未提供的事实。

外部历史事实核查涉及 Claim、Evidence、Verification、用户确认与 UI，属于更后续版本。

## 16. v2.3 最终原则

```text
固定路由 → Backend
固定上下文 → Backend 预取
语义判断 → Agent
专项方法 → Skill
动态只读额外信息 → Skill Script
普通历史检索 → memory-search.mjs / Classic Retrieval
复杂深层检索 → memory-deep-search.mjs / Agentic Retrieval
最终 Proposal → Backend Validate / Apply
```

工程目标：

> **减少 Agent Round Trip，而不是增加 Agent 数量。**

> **正常任务 1 次 Agent Run；复杂任务仍尽量在同一个 Agent Run 内完成必要 Script Loop。**

> **Realtime 追求及时；Agentic Deep Search 追求完整，两者不混用延迟预算。**

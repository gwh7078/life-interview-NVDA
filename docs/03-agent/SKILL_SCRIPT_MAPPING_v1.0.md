# Skill / Script Mapping v1.0

> Status: **Current Design Baseline**
>
> Scope: OpenClaw Agent Skills, future Retriever integration, Realtime Slow Agent
>
> Date: 2026-09-21

## 1. 冻结结论

本项目后续的动态只读检索能力，优先采用：

```text
Agent
↓
Skill
↓
Skill 内 scripts/*
↓
OpenClaw 通用 exec 能力
↓
Backend / Retriever API
↓
精简结构化结果
↓
同一个 Agent Run 继续推理
```

不再为 `memory_search`、`memory_deep_search`、`era_context_search` 分别向模型暴露复杂的专用 Product Tool Schema。

这里的“不再用 Tool”准确含义是：

- **不注册这些专用业务 Tool 给模型选择和填复杂参数；**
- OpenClaw 底层仍可能通过受限的通用 `exec` 能力执行 Skill 自带脚本；
- 模型只需要判断“是否需要检索”和“查询什么”；
- run_id / owner_id / story_id / token / Top-K / retrieval mode / rerank / endpoint 等确定性参数由脚本封装。

目的：

1. 减少模型每轮读取 Tool Schema 的上下文开销；
2. 减少模型选择 Tool 和填写参数的错误率；
3. 把多个确定性检索步骤压缩到一次脚本执行；
4. 保留 Agent 的真正自主性：决定是否搜索、搜索什么、如何解释结果。

## 2. 当前正式 Skill → Script 映射

| Skill / Mode | Script | 状态 | 说明 |
|---|---|---|---|
| `onboarding-closeout` | 无 | 当前 | 固定 Profile / Transcript 由 Backend 预注入，一次 Agent Run 完成 |
| `interview-closeout / story_create` | 无 | 当前 | 新 Story 所需 Context 已固定注入，不搜索历史 |
| `interview-closeout / story_continue` | `scripts/memory-search.mjs` | Phase 3A 本机已实现 / 真实服务待验收 | 出现明确历史疑点时做个人历史 Classic Retrieval |
| `interview-closeout / story_continue` | `scripts/memory-deep-search.mjs` | Future / Later | Classic Search 仍不足，且任务允许高延迟时做 Agentic Retrieval |
| `interview-closeout / contributor` | 无 | 当前 | 第三者证据与主人公历史隔离；禁止搜索主人公 Memory / Transcript |
| `story-completion` | 无 | 当前 | Completion 只读 Agent Memory，不回查 Transcript |
| `story-generation` | 无 | 当前 | 当前 Contract 已提供完整主人公 Transcript；不动态搜索 |
| Future `interview-observer` | `scripts/memory-search.mjs` | Future | Realtime Slow Agent 的个人历史 Classic Retrieval |
| Future `interview-observer` | `scripts/era-context-search.mjs` | Future | 年代背景只读检索；只用于话题提示 |
| Future `interview-observer` | `memory-deep-search.mjs` | **禁止** | Realtime 不允许 Agentic Retrieval 阻塞实时链路 |

## 3. Interview Closeout 推荐目录

```text
agent/skills/interview-closeout/
├── SKILL.md
├── references/
│   ├── story-create.md
│   ├── story-continue.md
│   └── contributor.md
└── scripts/
    ├── memory-search.mjs
    └── memory-deep-search.mjs
```

注意：`memory-search.mjs` 已完成最小受控脚本和授权边界；真实 Retriever 服务恢复后仍需完成线上 ingest/query 验收。`memory-deep-search.mjs` 仍属于 Future；当前 Phase 2B 核心 Task 不依赖 Retriever。

### 3.1 `memory-search.mjs`

职责：

```text
query
↓
自动取得当前 run / owner / resource scope
↓
调用 Backend RetrieverAdapter / Search API
↓
Classic Retrieval
↓
rerank
↓
小 Top-K
↓
统一 Evidence JSON
```

Agent 只提供最小查询，例如：

```text
node {baseDir}/scripts/memory-search.mjs "老张 天津 大学同学"
```

脚本不允许模型手动填写 owner_id、token、Retriever endpoint 等安全与基础设施参数。

### 3.2 `memory-deep-search.mjs`

只用于非实时、复杂跨历史问题。

典型升级条件：

```text
Agent Memory 不足
↓
memory-search.mjs 仍不足
↓
问题确实跨多个 Session / Story
↓
任务允许高延迟
↓
memory-deep-search.mjs
```

它可以在脚本内部封装多查询、检索、融合、裁剪等确定性/半确定性步骤，但最终只返回 Evidence，不写业务数据库。

## 4. Future Realtime Slow Agent 推荐目录

```text
agent/skills/interview-observer/
├── SKILL.md
└── scripts/
    ├── memory-search.mjs
    └── era-context-search.mjs
```

其中：

- `memory-search.mjs`：回答“用户以前说过什么”；
- `era-context-search.mjs`：回答“这个年代有哪些可能帮助唤起回忆的背景话题”。

Realtime Slow Agent 不使用 `memory-deep-search.mjs`。

## 5. 哪些能力不要做成脚本

以下属于语义判断，应由 Agent + Skill 完成：

```text
story-discovery
memory-reconcile
completion judgment
writing / revision
```

例如：

- “这是不是一个独立的新 Story？”
- “这是对旧 Memory 的 correct 还是 refine？”
- “这个 Story 是否已经足够完整？”

这些不是确定性数据获取，不能为了减少 Tool 而错误地下沉成脚本。

## 6. 哪些脚本明确禁止

不要创建：

```text
get-story-context.mjs
get-transcript.mjs
get-agent-memory.mjs
```

原因：固定 Context 已由 Backend 在 Agent Run 前预取，重新脚本读取只会增加一次 Round Trip。

也不要创建：

```text
update-story.mjs
update-memory.mjs
create-story.mjs
save-completion.mjs
save-document.mjs
```

原因：业务写入必须保持：

```text
Agent Proposal
↓
Backend Schema / Evidence Validation
↓
Version / Stale Check
↓
Transaction
↓
Domain Apply
↓
SQLite
```

Skill Script 只允许受限只读检索和确定性辅助处理，不拥有 Domain Write Authority。

## 7. Script 输入输出原则

脚本输入尽量小：

```text
query
可选：时间范围 / 最大结果数等低风险业务参数
```

基础设施参数不交给模型：

```text
run_id
owner_id
resource_id
auth token
endpoint
index name
retrieval implementation
reranker config
```

脚本输出统一为少量、可回溯结果，例如：

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

## 8. 安全边界

脚本必须继续遵守：

- sandbox；
- exec allowlist；
- owner / run / resource scope；
- 短期凭据；
- Backend authorization；
- audit log；
- read-only Retriever contract。

把能力放进 Skill Script 不等于绕开 Backend 权限系统。

## 9. 调用轮数原则

正常任务：

```text
Backend fixed Context
↓
Agent
↓
Final Proposal
```

目标：1 Agent Run，0 Retrieval Script。

复杂历史疑点：

```text
Backend fixed Context
↓
Agent
↓
exec Skill Script
↓
精简 Evidence
↓
同一个 Agent Run 继续推理
↓
Final Proposal
```

目标仍然是 **一个 Agent Run 内完成**。

脚本内部应尽量把 Search → Rerank → Source 补全 → Top-K 裁剪压缩成一次执行，避免 Agent 在多个低级 Tool 之间来回调用。

## 10. 与当前代码的关系

当前 `TaskDefinition.executionPolicy.dynamicTools` 和 runtime `toolCallCount` 是 Phase 2B 已有抽象。

在真正实现 Retrieval Script 时，应再版本化调整为更准确的能力声明，例如：

```text
scriptCapabilities
allowedExecScripts
scriptCallCount
```

不要为了兼容旧字段而重新暴露 `memory_search` 专用 Tool Schema。

当前仅冻结设计，不要求在本次文档更新中修改运行时代码。

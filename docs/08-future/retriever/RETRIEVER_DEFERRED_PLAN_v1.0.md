# NeMo Retriever Deferred Integration Plan v1.2

> Status: **Future / Deferred**
>
> 当前 Phase 2B 不做正式产品集成。
>
> 本版冻结 Classic Retrieval 与 Agentic Retrieval 的职责边界。

## 1. 当前决定

NeMo Retriever 适合后续承担长期检索能力，但当前优先级低于正式 Agent Runtime E2E、Retry / Repair 与模型评测。

因此：

- 当前 Product Workflow 不依赖 Retriever；
- 当前 Realtime 主链路不依赖 Retriever；
- 当前不为了 Retriever 修改 Task Contract；
- 已有部署 / Smoke 资料继续保留；
- Future 必须区分 **Classic Retrieval** 与 **Agentic Retrieval**；
- 个人历史 Classic Retrieval 与 Agentic Retrieval 共用同一份可重建的 Transcript Derived Index；
- Future 时代背景检索使用独立的只读公共背景索引，不与用户私有 Transcript Index 混存。

## 2. 数据职责

### SQLite

永远是 Source of Truth，保存 Profile、Life Stage、Story、Session、Full Transcript、Summary、Story Agent Memory、Gaps、Documents 与 Contributor data。

### Retriever

未来是 Derived Search Index，保存可重建的 Transcript chunks、embedding、metadata 与 searchable representation。

Retriever 丢失时必须能够从 SQLite 重建。

原则：

> Retrieval 结果是 Evidence Candidate，不是新的事实来源。

## 3. 写入原则

未来：

```text
Transcript successfully persisted
        |
        v
Async Retriever Index Job
```

Retriever 索引失败不允许回滚已保存 Transcript。

建议状态：

```text
pending
indexing
indexed
failed
```

索引至少携带：

- owner / profile scope；
- story_id；
- session_id；
- source message reference；
- speaker；
- source_type；
- searchable text。

## 4. 两级 Retrieval

### 4.1 Classic Retrieval

定位：

> **低延迟、单次或有限步骤的历史 Recall。**

典型：

```text
Query
 -> dense / hybrid retrieval
 -> rerank
 -> Top-K evidence
```

主要用于：

- Realtime Slow System 的按需 Recall；
- 旧人物、旧事件、时间点快速查找；
- 普通 Story 历史证据查询；
- 需要低延迟返回的 Agent Tool。

Future Tool 名：

```text
memory_search
```

原则：

- 条件触发，不是每轮固定 Search；
- 返回小 Top-K；
- 带 session / message source metadata；
- 不返回整个人生历史；
- Realtime 中必须旁路执行，不阻塞当前语音轮次。

### 4.2 Agentic Retrieval

定位：

> **高延迟预算下的复杂、多跳、跨 Session / Story 深度证据搜索。**

典型：

```text
Question
 -> Agent reasoning
 -> multiple retrieval sub-queries
 -> evidence fusion
 -> evidence selection
 -> final evidence set
```

主要用于 Future 非实时 Agent：

- Interview Closeout 的复杂历史冲突核查；
- 跨多个 Session / Story 的 Deep Recall；
- 人物 / 时间线多处证据搜集；
- 独立 Deep Evidence / Conflict Analysis；
- Story Generation 在证据规模很大时的辅助检索。

Future Tool 名：

```text
memory_deep_search
```

默认不用于：

- Realtime Voice 当前轮回答；
- 每轮语音固定检索；
- Agent Memory 已足够回答的问题；
- 低延迟 Completion 主路径。

原则：

> **Agentic Retrieval 是 Post-session / Offline Deep Search Tool，不是 Realtime 默认 Retriever。**

## 5. 条件式调用，而不是固定前处理

标准模式：

```text
Backend 预取固定 Context
↓
Agent 判断
├─ 信息足够
│  → 直接完成
│
├─ 普通历史疑点
│  → memory_search
│  → Classic Retrieval
│  → 少量高相关历史证据
│
└─ 复杂跨历史问题
   → memory_deep_search
   → Agentic Retrieval
   → 多步证据搜索
   ↓
同一个 Agent Run 继续判断
```

典型触发：

- 引用以前说过的内容；
- 人物身份无法判断；
- 当前陈述与长期记忆冲突；
- 疑似新 Story 与已有 Story 重复；
- 时间 / 地点 / 人物关系异常；
- 一个问题明显需要跨多个 Story / Session 才能回答。

目标：

> **正常任务 1 Run 0 Tool；普通复杂任务少量 Classic Search；真正复杂历史问题才升级 Agentic Search。**

## 6. Tool Contract 原则

正式访问必须经过 Backend / scoped tool / RetrieverAdapter。

浏览器和小程序不直接连接 Retriever。

两类 Tool 都必须：

- owner scoped；
- resource scoped；
- run scoped；
- 短期 token；
- audit log；
- 返回 Evidence，不直接写业务数据库。

建议统一 Evidence Contract：

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

Agent 最终仍遵循：

```text
Retrieved Evidence
 -> Agent Proposal
 -> Schema / Evidence Validation
 -> Domain Apply
 -> SQLite
```

## 7. 与 Agent Memory 的关系

三层长期读取不互相替代：

```text
L1 Story Agent Memory
 -> 默认长期工作记忆
 -> 最快

L2 Classic Retrieval
 -> 快速回到历史 Transcript Evidence
 -> 普通 Recall

L3 Agentic Retrieval
 -> 多查询 / 多跳 / 跨 Story Deep Evidence Search
 -> 非实时任务
```

原则：

> 默认先用 Agent Memory；出现普通疑点再 Classic Search；只有复杂问题才 Agentic Search。

## 8. Future 双检索源：个人历史 + 时代背景

Future Realtime Slow System 不只有一个“Memory Search”。

建议维护两个逻辑隔离的检索源：

```text
A. 个人历史证据索引
- 来源：用户 Transcript
- owner scoped
- 从 SQLite 派生
- 丢失后可重建

B. 时代背景索引
- 来源：预先整理的公共年代资料
- read-only
- 不包含用户私有数据
- 按年份 / 地域 / 类别 / 人生阶段等检索
```

Future Tool 可以分别设计为：

```text
memory_search
 -> 个人历史 Classic Retrieval

era_context_search
 -> 时代背景 Classic Retrieval
```

两者目标也不同：

```text
memory_search
 -> 回忆“用户以前说过什么”

era_context_search
 -> 找到“用户当时所处时代有什么可能唤起记忆的话题”
```

时代背景检索返回的是采访线索，不是用户 Evidence，因此不得直接进入用户事实链路。

详细设计：

- `ERA_CONTEXT_LIBRARY_v1.0.md`

## 9. Realtime 硬边界

Future Realtime：

```text
FAST Voice System
      |
      +--> Transcript Events
                |
                v
         Realtime Slow Agent
                |
                +--> Story Agent Memory
                |
                +--> Classic Retrieval
                |
                v
          Context Hint / Patch
                |
          Safe Turn Boundary
                |
                v
          FAST Voice System
```

Agentic Retrieval 不进入默认实时链路。

原因：

- 多轮 reasoning + retrieval 延迟不可稳定控制；
- 与 barge-in / interrupt 的实时语音体验不匹配；
- 会增加 DGX Spark 上模型与 Retriever 的资源竞争；
- Realtime 目标是“及时找到足够好的证据”，不是“搜索尽可能完整”。

## 10. 证据优先级

当前 Transcript 是当前直接证据。

Retriever 找到的历史 Transcript 是补充证据。

如果用户当前明确纠正旧说法：

> 当前明确纠正优先于旧历史陈述。

## 11. DGX Spark Future Deployment

目标形态：

```text
DGX Spark
├── Agent Runtime
├── Local Model Runtime
├── NeMo Retriever
│   ├── 个人历史证据索引
│   │   ├── Classic Retrieval
│   │   └── Agentic Retrieval
│   └── 时代背景只读索引
│       └── Classic Retrieval
├── Embedding / Reranker
└── SQLite / App Services
```

资源策略：

- Classic Retrieval 可作为常驻低延迟能力；
- Agentic Retrieval 按需触发；
- Realtime 活跃时不默认并行启动重型 Deep Search；
- Agentic Retrieval 的 Agent Model、并发数、P50 / P95 latency 必须在真实 Spark 上 Benchmark 后冻结；
- 未实测前，不承诺具体吞吐或延迟。

## 12. Future Integration Order

1. 稳定 Retriever 服务；
2. RetrieverAdapter；
3. Transcript async indexing；
4. scoped Evidence Search Contract；
5. `memory_search` / 个人历史 Classic Retrieval；
6. Interview Closeout 条件式 Classic Search 试验；
7. Realtime Slow Agent + 个人历史 Classic Retrieval；
8. 时代背景最小数据集与独立只读 Index；
9. `era_context_search` / 时代背景 Classic Retrieval；
10. Classic recall / era hint quality / latency / unnecessary-search benchmark；
11. `memory_deep_search` / Agentic Retrieval；
12. Offline Agent Deep Search integration；
13. Agentic recall quality / latency / resource benchmark；
14. 根据真实效果决定是否扩大使用范围。

## 13. 当前冻结结论

> **Future Realtime = Story Agent Memory + 条件式个人历史 Classic Retrieval + 条件式时代背景 Classic Retrieval。**
>
> **Post-session / Offline Deep Evidence Task = Agentic Retrieval。**
>
> **用户个人历史：SQLite / Transcript 永远是 Source of Truth，个人历史 Retriever 只是可重建的派生证据索引。**
>
> **时代背景索引是独立只读公共资料库，只能提供采访话题提示，不属于用户事实证据。**

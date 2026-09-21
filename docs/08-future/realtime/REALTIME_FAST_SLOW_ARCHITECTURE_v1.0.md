# Realtime Fast / Slow Dual-System Architecture v1.4

> Status: **Future / Deferred**
>
> 当前版本不开发，只冻结演进方向。
>
> 本版明确：Realtime Slow Agent 仍是 **Future / Deferred**。未来可在不阻塞语音的前提下使用 Story Agent Memory + Classic Retrieval，并把检索分为个人历史召回、个人历史事实检索与时代背景检索；Agentic Retrieval 不进入默认实时链路。
>
> v1.4 新增两条冻结机制：**Slow Agent 全程不阻塞 Fast System**；**Slow Queue 采用 latest-only，不允许形成历史任务积压**。

## 1. 问题

Realtime Interview 同时要求低延迟自然交流，以及历史 Recall、冲突检测和深层采访规划。

如果全部串行：

```text
User Speech
 -> Retriever
 -> Agent
 -> Tools
 -> Model
 -> Voice Response
```

检索与推理延迟会直接暴露给用户。

核心原则：

> **Slow System 永远不阻塞当前语音轮次。**

## 2. Future Architecture

```text
用户
 ↕
FAST SYSTEM
Realtime Voice Model
即时自然对话
        |
        | Transcript Events
        v
SLOW SYSTEM
Interview Slow Agent
        |
        ├─ 判断是否需要历史信息
        ├─ 判断人物 / 时间 / Story 线索
        ├─ 条件式个人历史召回
        ├─ 条件式个人历史事实检索
        ├─ 条件式时代背景检索
        └─ 形成短 Context Hint
        |
        v
Context Bridge
        |
   Safe Turn Boundary
        |
        v
FAST SYSTEM 下一轮
```

## 3. 两条 Realtime 硬规则

### 3.1 Slow Agent 全程不阻塞 Fast System

Fast System 与 Slow System 之间只能是旁路异步关系：

```text
Transcript Event
     |
     +----> FAST SYSTEM 继续当前语音轮次
     |
     +----> SLOW SYSTEM 异步处理
```

冻结规则：

- Fast System 发送 Transcript Event 后立即继续，不 `await` Slow Agent；
- 当前语音回答不得等待 Slow Decision、Retriever、Memory Search 或 Context Hint；
- Slow System 超时、报错、未加载或资源不足时，Fast System 继续工作；
- Slow System 不能对正在生成或播放的当前回答做中途改写；
- Slow Result 只允许在后续 Safe Turn Boundary 注入；
- Slow Queue 满载时只能替换 / 丢弃慢任务，不能向 Fast System 施加 backpressure；
- Realtime Voice 的可用性优先级高于 Slow System 的完整性。

原则：

> **Slow Intelligence 可以迟到或被丢弃，但不能让实时对话等待。**

### 3.2 Slow Queue = latest-only

Realtime Interview 是持续输入流，Slow Agent 不允许使用普通 FIFO 队列积压历史任务。

每个 Session 的 Slow Queue 最多保持：

```text
1 × active
+
1 × pending_latest
```

示例：

```text
Turn 18
 -> Slow Run A 正在执行

Turn 19
 -> pending = Turn 19

Turn 20 到达
 -> 不追加 Turn 20
 -> 直接用 Turn 20 替换 pending Turn 19

A 完成
 -> 先做 Stale Protection
 -> 然后只处理最新 pending Turn 20
```

冻结规则：

- 已在执行的 active task 默认不强制取消；
- 运行时若未来支持安全 cancellation，可以优化，但不是正确性前提；
- 新任务到达时只覆盖 `pending_latest`，不形成 FIFO 队列；
- 被覆盖的 pending task 不再执行；
- active task 返回后必须先经过 Stale Protection；
- active result 已过期则直接 DROP，不为了“已经算完了”而注入；
- Slow System 永远优先处理“现在最相关的上下文”，而不是补做已经过去的历史窗口。

目的：

- 防止长访谈中慢任务越积越多；
- 避免 10～30 秒前的分析污染当前话题；
- 降低 DGX Spark 上高频 Slow Decision / Retrieval 的无效资源消耗；
- 让 Slow System 的计算量天然受实时对话速度约束。

### 3.3 最低验收测试

未来实现时至少增加：

1. **Latest-only Test**：Active=A 时连续提交 B/C/D，最终 Pending 只能是 D；
2. **No-block Test**：Slow Agent 人工延迟 10 秒，Fast Voice 当前轮延迟不增加；
3. **Slow Failure Test**：Slow Runtime 报错 / 超时，Fast Session 不终止；
4. **Stale Drop Test**：旧 `based_on_turn_id` 结果返回后不能注入当前轮；
5. **Burst Test**：连续高频 Transcript Event 下，pending depth 始终 ≤ 1；
6. **Safe Boundary Test**：Slow Result 只能在允许的下一轮边界生效。

---

## 5. Fast System

负责：

- realtime speech；
- 当前 session 上下文；
- 快速追问；
- interrupt / barge-in；
- 当前轮自然交流。

Fast System：

- 不等待 Retriever / Memory Search；
- 不直接读取大批历史 Transcript；
- 不调用 Agentic Retrieval；
- 不写长期 Story Memory。

## 5. Slow System 的真正 Agent 自主性

Slow Agent 不是每轮固定执行 Retriever。

它持续观察 Transcript，并自主判断：

- 当前信息是否值得处理；
- 是否引用了过去内容；
- 是否出现旧人物；
- 是否存在时间冲突；
- 是否出现疑似新 Story；
- 是否偏离当前采访目标；
- 是否值得进一步深挖；
- 是否需要个人历史召回；
- 是否需要个人历史事实检索；
- 当前对话中出现的年份 / 时间范围是否值得触发时代背景检索。

只有符合条件时才调用 Tool。

这使自主性来自真实业务判断，而不是无意义的固定多轮调用。

## 6. Realtime 只允许 Classic Retrieval

Future Realtime 低延迟检索统一采用 Classic Retrieval，但逻辑上分为两类数据源：

```text
个人历史证据索引
 -> memory_search
 -> Transcript / 历史事实

时代背景索引
 -> era_context_search
 -> 年份范围过滤 + 当前话题语义检索

两者
 -> Classic Retrieval
 -> dense / hybrid retrieval
 -> rerank
 -> small Top-K evidence / hints
```

个人历史证据索引属于用户私有数据；时代背景索引属于只读公共背景库，两者必须隔离。

原因：

- 延迟比多步 Agentic Search 更可控；
- 结果可以在下一 Safe Turn Boundary 前到达；
- 更适合长时间叙述、频繁插话的语音场景；
- 资源占用更容易与 Realtime Voice Model 共存。

Realtime 目标：

> **及时找到足够好的证据，而不是把历史搜索到最完整。**

## 7. Agentic Retrieval 的边界

Agentic Retrieval 需要：

```text
reason
 -> sub-query
 -> retrieve
 -> reason
 -> retrieve
 -> fuse
 -> select
```

因此不进入默认 Realtime Path。

冻结：

```text
Realtime Slow Agent
 -> Classic Retrieval

Post-session / Offline Agent
 -> Agentic Retrieval
```

Agentic Retrieval 详细设计见：

- `../retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`

## 8. SlowContextUpdate / Context Hint

Slow Agent 不直接替用户回答，也不把 Top-K raw chunks 无差别塞给 Voice Model。

它只产生短 Context Hint，例如：

```json
{
  "based_on_turn_id": "turn_18",
  "memory_recall": [
    {
      "claim": "用户此前提到大约 1978 年进厂",
      "source_message_ids": ["msg_123"]
    }
  ],
  "possible_conflicts": [
    {
      "current": "1979 年进厂",
      "previous": "约 1978 年进厂",
      "action": "clarify_if_natural",
      "source_message_ids": ["msg_123"]
    }
  ],
  "interview_hints": [
    "如果自然，可询问王师傅第一次带他工作的场景"
  ]
}
```

原则：

> **Retriever 返回 Evidence；Slow Agent 返回 Context Hint；Fast Voice System 消费 Context Hint。**

## 9. 注入规则

Slow Result 只允许在 Safe Turn Boundary 注入：

- 用户正在说话：不注入；
- Fast System 正在生成当前回答：不强制改变；
- 下一轮生成前：可以注入；
- 已经过时：丢弃。

## 10. Stale Protection

至少带：

```text
slow_run_id
session_id
based_on_turn_id
context_version
expires_after_turn
```

## 11. 条件式 Memory Search 触发

适合触发：

- “我以前跟你说过……”；
- 旧人物重新出现；
- 时间可能冲突；
- Story 跳跃；
- 用户主动引用历史；
- Slow Agent 判断当前 Context 不足。

不适合：

- 每个 Turn 固定 Search；
- 为了展示 Tool Calling 固定 Search；
- 简单 Agent Memory 已经足够时仍 Search。

## 12. 可以提前检索，不提前回答

人生采访常出现长叙述。

Future 可以：

```text
Partial Transcript / Entity Signal
 -> candidate Classic Retrieval prefetch
 -> user turn final
 -> validate
 -> reuse or discard
```

但不建议因为用户尚未说完就提前生成下一条语音回答。

原则：

> **Speculative Retrieval 可以；Speculative Response 谨慎。**

## 13. Slow System 不写长期 Story Memory

Slow Recall 只服务当前 Realtime Session。

永久 Story Agent Memory 继续由 Interview Closeout 在访谈结束后统一维护。

```text
FAST SYSTEM
  当前轮怎么自然聊

REALTIME SLOW SYSTEM
  当前聊天是否需要快速历史资料帮助
  Story Agent Memory + Classic Retrieval

OFFLINE DEEP SEARCH
  复杂跨 Session / Story 证据搜索
  Agentic Retrieval

CLOSEOUT AGENT
  本次访谈结束后长期应该记住什么
```

## 14. Future：时代背景检索

未来 Slow System 除了“找回用户过去说过什么”，还可以理解“用户当时生活在什么时代”。

典型链路：

```text
用户提到：
年份 / 时间范围
        |
        v
时代背景 Classic Retrieval
        |
        v
少量高相关年代事件
        |
        v
Slow Agent 选择 0～2 条自然话题
        |
        v
Context Hint
        |
        v
Safe Turn Boundary
        |
        v
Fast Realtime System
```

例如用户说：

> “我大概 2000 年左右刚参加工作。”

Slow System 未来可以先筛选 1998～2002 年的时代背景，再根据当前对话语义找到少量相关候选。

时代背景库本身不保存建议问题；慢系统结合完整上下文决定是否使用，以及应该形成什么话题提示。

硬边界：

- 时代背景只用于唤起记忆和寻找话题；
- 第一版时代库暂不使用地域字段；
- 第一版先按年份范围过滤，再做语义检索；
- 时代库不预存建议问题，问题建议由 Slow Agent 动态生成；
- 时代背景不是用户个人事实；
- 用户未确认前不得进入 Story Summary / Agent Memory / Completion / Generation；
- 不允许为了使用检索结果而强行打断高信息密度个人叙述；
- 默认只使用低延迟 Classic Retrieval，不需要 Agentic Retrieval。

详细设计见：

- `../retriever/ERA_CONTEXT_LIBRARY_v1.0.md`

## 15. 当前版本边界

当前 Fast Realtime 保持现有实现；Slow System、Realtime Retriever、Memory Search、时代背景检索、Agentic Retrieval 均不开发。

当前只保证未来能够：

- 旁路消费 Transcript Event；
- 在不阻塞 Fast System 的前提下运行；
- 条件式 Tool Calling；
- 在安全轮次边界注入短 Context；
- 后续接入 Classic Retrieval 时不修改 Realtime 主业务协议。

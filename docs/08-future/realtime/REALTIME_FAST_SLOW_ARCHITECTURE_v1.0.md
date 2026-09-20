# Realtime Fast / Slow Dual-System Architecture v1.1

> Status: **Future / Deferred**
>
> 当前版本不开发，只冻结演进方向。
>
> 本版明确：Realtime Slow Agent 只使用 Story Agent Memory + Classic Retrieval；Agentic Retrieval 不进入默认实时链路。

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
        ├─ 条件式 Classic Memory Search
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

## 3. Fast System

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

## 4. Slow System 的真正 Agent 自主性

Slow Agent 不是每轮固定执行 Retriever。

它持续观察 Transcript，并自主判断：

- 当前信息是否值得处理；
- 是否引用了过去内容；
- 是否出现旧人物；
- 是否存在时间冲突；
- 是否出现疑似新 Story；
- 是否偏离当前采访目标；
- 是否值得进一步深挖；
- 是否需要 Memory Search。

只有符合条件时才调用 Tool。

这使自主性来自真实业务判断，而不是无意义的固定多轮调用。

## 5. Realtime 只允许 Classic Retrieval

Future Realtime Memory Search 使用：

```text
memory_search
 -> Classic Retrieval
 -> dense / hybrid retrieval
 -> rerank
 -> small Top-K evidence
```

原因：

- 延迟比多步 Agentic Search 更可控；
- 结果可以在下一 Safe Turn Boundary 前到达；
- 更适合长时间叙述、频繁插话的语音场景；
- 资源占用更容易与 Realtime Voice Model 共存。

Realtime 目标：

> **及时找到足够好的证据，而不是把历史搜索到最完整。**

## 6. Agentic Retrieval 的边界

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

## 7. SlowContextUpdate / Context Hint

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

## 8. 注入规则

Slow Result 只允许在 Safe Turn Boundary 注入：

- 用户正在说话：不注入；
- Fast System 正在生成当前回答：不强制改变；
- 下一轮生成前：可以注入；
- 已经过时：丢弃。

## 9. Stale Protection

至少带：

```text
slow_run_id
session_id
based_on_turn_id
context_version
expires_after_turn
```

## 10. 条件式 Memory Search 触发

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

## 11. 可以提前检索，不提前回答

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

## 12. Slow System 不写长期 Story Memory

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

## 13. 当前版本边界

当前 Fast Realtime 保持现有实现；Slow System、Realtime Retriever、Memory Search、Agentic Retrieval 均不开发。

当前只保证未来能够：

- 旁路消费 Transcript Event；
- 在不阻塞 Fast System 的前提下运行；
- 条件式 Tool Calling；
- 在安全轮次边界注入短 Context；
- 后续接入 Classic Retrieval 时不修改 Realtime 主业务协议。

# Realtime Fast / Slow Dual-System Architecture v1.0

> Status: **Future / Deferred**
>
> 当前版本不开发，只冻结演进方向。

## 1. 问题

Realtime Interview 同时要求低延迟自然交流，以及历史 Recall、Retriever、冲突检测和深层规划。

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

## 2. Future Architecture

```text
                    +----------------------+
User Audio -------->| FAST SYSTEM          |
                    | Realtime Voice Model |
                    | Immediate Dialogue   |
                    +----------+-----------+
                               |
                         Transcript Events
                               |
                               v
                    +----------------------+
                    | SLOW SYSTEM          |
                    | Agent                |
                    | Retriever            |
                    | Memory Search        |
                    | Conflict Detection   |
                    | Deep Recall          |
                    +----------+-----------+
                               |
                         Context Update
                               |
                               v
                    +----------------------+
                    | Context Bridge       |
                    +----------+-----------+
                               |
                       Safe Turn Boundary
                               |
                               v
                          FAST SYSTEM
```

核心：

> **Slow System 永远不阻塞当前语音轮次。**

## 3. Fast System

继续负责 realtime speech、当前 session 上下文、快速追问、interrupt 与当前访谈策略执行。它不等待 Retriever / Memory Search。

## 4. Slow System

旁路消费 user turn completed、assistant turn completed、important entity mentioned、possible conflict、recall request、topic shift 等事件。

可调用：

- NeMo Retriever；
- Story Agent Memory；
- 历史 Transcript Search；
- Timeline / Entity Recall；
- Conflict Detection；
- Deep Interview Planning。

## 5. SlowContextUpdate

Slow System 不直接替用户回答，只产生临时 Context Update，例如：

```json
{
  "based_on_turn_id": "turn_18",
  "memory_recall": ["用户此前提到该同学叫张伟"],
  "possible_conflicts": ["之前提到 2008 年，本轮说 2009 年"],
  "interview_hints": ["如果自然，可询问张伟在事件中的角色"]
}
```

## 6. 注入规则

Slow Result 只允许在 Safe Turn Boundary 注入：

- 用户正在说话：不注入；
- Fast System 正在生成当前回答：不强制改变；
- 下一轮生成前：可以注入；
- 已经过时：丢弃。

## 7. Stale Protection

未来至少带：

```text
slow_run_id
session_id
based_on_turn_id
context_version
expires_after_turn
```

Context Bridge 根据当前 Turn 与 Session 判断结果是否仍有效。

## 8. Triggered Recall

不要求每轮都跑 Retriever。适合触发的场景：

- “我以前跟你说过……”；
- 旧人物重新出现；
- 时间可能冲突；
- Story 跳跃；
- 用户主动询问历史；
- Interview Agent 判断上下文不足。

## 9. Slow System 不写长期 Story Memory

Slow Recall 只服务当前 Realtime Session。永久 Story Agent Memory 继续由 Interview Closeout 在访谈结束后统一维护。

最终职责：

```text
FAST SYSTEM
  当前轮怎么自然聊

SLOW SYSTEM
  当前聊天是否需要历史资料帮助

CLOSEOUT AGENT
  本次访谈结束后长期应该记住什么
```

## 10. 当前版本边界

当前 Fast Realtime 保持现有实现；Slow System、Realtime Retriever 均不开发。只确保未来能够旁路消费 Transcript Event。

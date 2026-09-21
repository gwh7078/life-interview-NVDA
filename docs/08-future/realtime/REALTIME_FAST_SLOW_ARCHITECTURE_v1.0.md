# Realtime Fast / Slow Dual-System Architecture v1.5

> Status: **Future / Deferred**
>
> 当前版本不开发，只冻结演进方向。
>
> 本版明确：Realtime Slow Agent 仍是 **Future / Deferred**。未来可在不阻塞语音的前提下使用 Story Agent Memory + Classic Retrieval，并把检索分为个人历史召回、个人历史事实检索与时代背景检索；Agentic Retrieval 不进入默认实时链路。
>
> v1.5 冻结新的实时交互策略：**用户说话与正在进行的 Fast Voice 生成永不被 Slow System 中途阻塞；用户回答结束后允许最多约 5～6 秒的条件式 Hold**。每轮由轻量 Judge 判断是否需要检索；同时投机执行 Query Embedding / 首阶段召回。Judge 判定无需检索则立即 Release；需要检索则在硬 Deadline 内完成 Rerank + Evidence Summary 后再 Release。异常情况下继续保留 **latest-only + stale protection**。

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

> **Slow System 不阻塞用户说话和正在进行的语音生成；只允许在用户回答结束后的 Turn Boundary 做有硬截止时间的条件式 Hold。**

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

## 3. Realtime 硬规则

### 3.1 条件式 Hold，而不是全程异步

Slow System 不允许打断用户说话，也不允许中途改写 Fast Voice 正在生成 / 播放的回答。

但在一个 User Turn 完整结束、拿到 `Transcript Final` 后，允许进入短暂 Turn Boundary Hold：

```text
用户回答结束 / Transcript Final
            ↓
         HOLD START
            ↓
   Judge + Query Embedding / First-stage Retrieval 并行
            ↓
     ┌──────┴──────┐
     │             │
 Judge = No     Judge = Yes
     │             │
立即 Release    Rerank + Evidence Summary
     │             │
     └──────┬──────┘
            ↓
       HARD DEADLINE
        约 5～6 秒
            ↓
          Release
            ↓
      Fast Voice 下一问
```

冻结规则：

- 用户正在说话时：Slow System 不阻塞、不抢占对话控制权；
- Fast Voice 已经开始生成 / 播放当前回答时：Slow Result 不做中途注入；
- 只有在 `Transcript Final` 后的 Turn Boundary 可以 Hold；
- Judge 判定“不需要检索”时立即 Release，不等待已经投机执行的 Embedding / Retrieval；
- Judge 判定“需要检索”时，允许继续占用当前 Hold 预算；
- 从 Hold Start 到 Release 的产品硬预算目标为 **约 5～6 秒**；
- 到 Deadline 仍未完成：必须 Release Fast Voice，不能无限等待；
- Deadline 后返回的 Slow Result 只有仍 relevant 才允许作为后续轮次候选，否则 DROP。

原则：

> **绝大多数轮次只付 Judge 延迟；只有真正需要历史信息的轮次才付完整 Slow Path 延迟。**

### 3.2 Slow Queue = latest-only（异常保护）

正常情况下，单轮 Slow Path 应在 5～6 秒 Deadline 内结束，不应形成队列。

latest-only 主要用于模型卡顿、Retriever 变慢、用户异常快速连续输入等情况。每个 Session 最多保持：

```text
1 × active
+
1 × pending_latest
```

新任务只覆盖 `pending_latest`，不形成 FIFO 历史积压。

示例：

```text
Turn 18
 -> Slow Run A 尚未结束

Turn 19
 -> pending_latest = Turn 19

Turn 20 又到达
 -> pending_latest 直接替换为 Turn 20

A 完成
 -> 先做 Stale Protection
 -> 过期则 DROP
 -> 然后只处理最新 pending Turn 20
```

冻结规则：

- active task 默认不强制取消；
- 被新 Turn 覆盖的 pending task 不再执行；
- active result 返回后必须先经过 Stale Protection；
- 不能因为“已经算完”就强行把旧结果注入当前话题；
- Slow System 永远优先现在最相关的上下文。

### 3.3 Judge 固定 3 轮上下文

Judge 每轮固定读取最近 **3 个完整对话轮次**，不是动态扩缩窗口。

语义角色必须明确：

```text
[REFERENCE TURN -2]
Assistant: ...
User: ...

[REFERENCE TURN -1]
Assistant: ...
User: ...

[TARGET TURN]
Assistant: ...
User: ...
```

规则：

- `TARGET TURN` 是本轮唯一判断主体；
- 前两轮只用于理解人物、指代、时间、话题延续和上下文；
- 不允许仅因为 Reference Turn 本身“值得检索”而触发当前轮检索；
- Prompt 必须显式告诉 Judge：**判断 TARGET，Reference 只作背景**；
- 固定三轮的原因是避免运行时上下文策略漂移，并让 2B 级模型保持稳定输入模式。

需要专门增加“Reference 有检索价值、Target 无检索价值”的反例测试，验证小模型不会被前两轮带偏。

### 3.4 Speculative Embedding / Retrieval

为降低 Search Path 延迟，Judge 与 Query Embedding 可以每轮并行执行。

Retrieval Query 不使用三轮完整对话直接做一个 Embedding。优先使用两路 Query：

```text
Query A
= 当前 TARGET User Answer

Query B
= TARGET Assistant Question + TARGET User Answer
```

两路可以并行 Embedding，并可进一步提前执行首阶段 Dense / Hybrid Recall：

```text
Transcript Final
      ├─> Judge（最近 3 轮）
      ├─> Query A Embedding → candidate recall
      └─> Query B Embedding → candidate recall
```

Judge = No：

- 丢弃本轮 speculative embedding / candidates；
- 立即 Release。

Judge = Yes：

- 复用已经完成的 embedding / candidates；
- merge / dedupe；
- Rerank；
- Small Top-K；
- Evidence Summary。

原则：

> **允许浪费少量 Embedding / 首召回计算，换取需要搜索时更短的用户等待。**

### 3.5 最低验收测试

未来实现时至少增加：

1. **No-search Release Test**：Judge=No 时不等待 Embedding / Retrieval 完成；
2. **Hold Deadline Test**：完整 Slow Path 超过 5～6 秒时强制 Release；
3. **Parallelism Test**：Judge 与 Embedding / 首召回确实并行，而不是串行；
4. **Reference-vs-Target Test**：前两轮值得搜、Target 不值得搜时不得误触发；
5. **Latest-only Test**：Active=A 时连续提交 B/C/D，Pending 最终只能是 D；
6. **Slow Failure Test**：Judge / Retriever / Summary 任一失败不终止 Realtime Session；
7. **Stale Drop Test**：旧 `based_on_turn_id` 结果不能污染当前话题；
8. **Safe Boundary Test**：Slow Result 只能在允许的 Turn Boundary 生效；
9. **End-to-end Budget Test**：Judge=Yes 路径记录 P50 / P95，并验证真实 Spark 上能否稳定落在 5～6 秒预算内。

---

## 4. Fast System

负责：

- realtime speech；
- 当前 session 上下文；
- 快速追问；
- interrupt / barge-in；
- 当前轮自然交流。

Fast System：

- 用户说话以及 Fast Voice 正在生成 / 播放时，不等待 Retriever / Memory Search；
- 仅在 User Turn Final 后按 §3 的 5～6 秒硬预算进入条件式 Hold；
- 不直接读取大批历史 Transcript；
- 不调用 Agentic Retrieval；
- 不写长期 Story Memory。

## 5. Slow System 的真正 Agent 自主性

Slow System **每个 User Turn Final 都触发一次 Judge**，但不是每轮固定执行 Retriever。

当前模型候选优先采用轻量 2B 级 Judge。Judge 读取固定最近 3 轮，其中前两轮是 Reference，最后一轮是 Target，然后判断：

- Target 是否需要 Slow Search；
- 是否引用历史信息；
- 是否出现旧人物；
- 是否存在时间 / 人物关系冲突；
- 是否出现疑似新 Story；
- 是否值得进一步深挖；
- 是否需要个人历史检索；
- 是否需要时代背景检索。

Judge 输出应非常短、结构化，不负责面向用户生成回答。

只有 Judge 判定需要 Search 时，才继续消费已经 speculative 生成的 Retrieval Candidate，并执行 Rerank / Evidence Summary。

这使自主性来自：

> **每轮都判断，但不是每轮都搜索。**

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

## 8. Evidence Summary / Context Hint

Realtime Slow Path 不再默认调用 35B 模型做 Context Hint。

当前优先方案是：**同一个轻量 2B 模型同时承担 Judge 与 Evidence Summary 两个窄职责 Prompt**。

Evidence Summary 输入：

- 固定最近 3 轮对话；
- Judge 结构化信号；
- Small Top-K Evidence；
- 必要的 source refs。

输出必须极短，只保留 Realtime 下一问真正需要的信息，例如：

```json
{
  "based_on_turn_id": "turn_18",
  "facts": [
    {
      "claim": "用户此前提到王师傅是入厂后的第一位师傅",
      "source_message_ids": ["msg_123"]
    }
  ],
  "possible_conflicts": [],
  "interview_hints": [
    "如果自然，可以追问第一次跟王师傅上班的场景"
  ]
}
```

原则：

> **Retriever 返回 Evidence；2B Evidence Summary 压成短 Context Hint；Fast Voice 消费 Context Hint。**

2B 是否足以承担 Evidence Summary，必须通过真实采访 Eval 验证；如果质量不足，再升级模型，而不是预先固定 35B 进入 Realtime Path。

## 9. 注入与 Release 规则

Slow Result 的正常注入点就是当前 User Turn 结束后的 Hold Boundary。

- Judge = No：立即 Release，不注入 Slow Context；
- Judge = Yes 且 5～6 秒内完成：先注入短 Context Hint，再 Release Fast Voice；
- 用户已经开始下一轮说话：不强制插入；
- Fast Voice 已经开始生成 / 播放：不做中途改写；
- Deadline 已到：先 Release；
- Deadline 后结果仍 relevant：可以作为下一轮候选；
- 已经过时：DROP。

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

## 12. 每轮允许投机 Embedding / 首阶段召回

当前冻结策略比“检测到实体后再提前检索”更明确：

> **每个 User Turn Final 都允许 Judge 与 Query Embedding / First-stage Retrieval 并行启动。**

原因：

- Query Embedding 成本远小于一次完整 LLM 推理；
- 用户每轮问答通常已有约 15 秒以上自然间隔；
- 真正需要 Search 时，可以节省串行等待；
- Judge=No 时直接丢弃结果即可。

注意：

- 这里计算的是 Query Embedding，不是重新 Embedding 历史知识库；
- 历史 Transcript / Agent Memory 索引应该提前建立；
- 三轮完整上下文只给 Judge / Evidence Summary；
- Retrieval Query 使用当前回答，以及“当前问题 + 当前回答”两路；
- speculative recall 不能自动写入 Memory，也不能直接影响 Realtime；
- 是否真正采用搜索结果仍由 Judge 决定。

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

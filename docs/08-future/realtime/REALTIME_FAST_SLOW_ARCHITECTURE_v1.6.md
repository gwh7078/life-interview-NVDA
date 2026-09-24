# Realtime Fast / Slow Dual-System Architecture v1.6

> Status: **Architecture baseline; current implementation details are in `docs/05-development/phases/REALTIME_SLOW_CONTEXT_IMPLEMENTATION_v1.0.md`**
>
> Date: 2026-09-22
>
> Supersedes the previous Future recommendation: `REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`（内部版本 v1.5）
>
> 原有 Tool Call、HOLD/Resume、Slow Coordinator、Current Story Retriever 与 Phase 3 A+B 自动 Gate G0–G8 是已验证基线。2026-09-23 新增 `interview.context_hint` Agent 实现；本机真实 Agent smoke 未通过，完整 Fast/Slow 语音链路仍未验收。以实现状态文档中的 PASS/FAIL/NOT TESTED 为准。
>
> 本阶段的实时 Slow Path 验收范围是 Step-Audio / StepFun；Qwen 保留为 inactive / legacy provider adapter，不在本阶段新增历史上下文 Tool。

## 1. 本版核心变化

v1.6 将 Realtime 慢系统触发逻辑调整为：

> **优先由 Step-Audio Realtime Voice Model 自己决定是否发起 Tool Call；Tool Call 作为当前模型生成的暂停点；Backend / Adapter 执行 Slow Agent 与 Retrieval；结果返回后再交回 Step-Audio，由 Step-Audio 继续当前轮语音回答。**

因此原 v1.5 的“每个 User Turn Final 固定先跑独立 2B Judge”不再是默认主路径。

新的默认候选：

```text
User Speech
   ↓
Step-Audio Realtime Voice Model
   ├─ 无需历史 / 慢系统
   │    → 直接继续采访
   │
   └─ 需要额外上下文
        → tool_call(get_interview_context)
        → 当前模型生成结束 / HOLD
        → Backend Tool Adapter
        → Slow Agent
        → Classic Retrieval / Era Context Search
        → Context Hint
        → tool result 回灌 Step-Audio
        → 再次调用 Step-Audio
        → 继续当前轮语音回答
```

**注意：该方向必须先完成 Step-Audio-2-mini 的真实 Tool Trigger Eval，才能最终删除独立 Judge。**

## 2. 为什么调整

Step-Audio 本身已经处在 Fast Voice 的完整语音上下文中，能够同时利用：

- 当前用户语义；
- 当前多轮对话；
- 音频中的语速、语气、停顿与副语言线索；
- 当前采访 Prompt；
- Tool 描述及参数 Schema。

如果再让每轮 Transcript Final 固定经过独立 Judge：

```text
Step-Audio
→ Transcript
→ Judge
→ 是否搜索
→ Slow Agent
→ 再回 Step-Audio
```

会增加：

- 一次额外模型调用；
- 一层触发逻辑漂移；
- 延迟；
- 部署复杂度；
- Fast Voice 与 Judge 对“是否需要历史信息”的双重判断。

因此优先测试：

> **让正在负责采访的 Step-Audio 自己成为 Slow System Trigger Judge。**

## 3. Tool Calling 的运行语义

### 3.1 Tool Call 不是“模型后台自己调用”

Step-Audio 输出 Tool Call 后，**当前这一轮模型生成结束**。

模型不会自己：

- 发 HTTP 请求；
- 等待 OpenClaw；
- 自动恢复；
- 自动把 Slow Agent 结果拼回上下文。

这些全部由应用层负责。

标准控制流：

```text
Step-Audio Run A
        ↓
tool_call
        ↓
Run A 结束
        ↓
Backend / Adapter 执行 Tool
        ↓
等待 Tool Result
        ↓
把 Tool Result 加回当前 Session Context
        ↓
Step-Audio Run B
        ↓
根据 Tool Result 继续生成语音
```

因此 Tool Call 天然可以成为 Realtime 的 **Turn Boundary Hold Point**。

### 3.2 默认采用同步 HOLD

人生采访局默认候选：

```text
Step-Audio 触发 Tool
        ↓
HOLD START
        ↓
Backend Adapter
        ↓
Slow Agent / Retrieval
        ↓
≤ 5~6 秒
        ↓
结果返回
        ↓
tool result / context hint 回灌
        ↓
Step-Audio 继续
```

如果超过 Deadline：

```text
Slow Path timeout
        ↓
Backend 返回 timeout / no-context result
        ↓
Step-Audio 继续当前采访
```

不能无限等待 Slow System。

## 4. Step-Audio 不直接调用 OpenClaw Agent

Step-Audio 只看到一个受限的产品级 Tool，例如：

```json
{
  "type": "function",
  "function": {
    "name": "get_interview_context",
    "description": "当继续采访需要历史资料、人物关系、时间事实或时代背景帮助时调用",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string"
        }
      },
      "required": ["query"],
      "additionalProperties": false
    }
  }
}
```

模型只负责表达：

> “我现在缺什么信息？”

例如：

```json
{
  "query": "用户再次提到王师傅，需要确认此前的人物关系与相关经历"
}
```

Backend 自动补齐内部控制信息：

```text
session_id
turn_id
owner_id
story_id
resource scope
context_version
deadline
stale protection
recent turns
Story Agent Memory
```

然后再调用 Slow Agent。

原则：

> **Voice Model 决定信息需求；Backend 决定权限、范围、生命周期和执行。**

## 5. Slow Agent 职责

Slow Agent 不再默认承担“每轮先判断要不要 Search”的第一触发职责。

当 Step-Audio 已发起 Tool Call 后，Slow Agent 负责：

- 解析 query；
- 判断需要哪类证据；
- Story Agent Memory recall；
- 个人历史 Classic Retrieval；
- 个人历史事实检索；
- 时代背景 Classic Retrieval；
- 人物 / 时间 / Story 线索整理；
- 冲突提示；
- 形成极短 Context Hint。

Realtime 仍然禁止默认使用 Agentic Retrieval。

```text
Realtime Slow Agent
 -> Classic Retrieval

Post-session / Offline Deep Search
 -> Agentic Retrieval
```

## 6. Context Hint 输出

建议继续保持极短结构：

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

- Evidence 可以多一点；
- 回给 Step-Audio 的 Context Hint 必须少；
- 不把大量历史 Transcript 重新塞给 Voice Model；
- Retriever 结果不能直接写 Story Memory。

## 7. 情绪 / 副语言信息的边界

Step-Audio 能直接从原始音频理解语气、语速、停顿等副语言线索。

默认策略：

> **情绪主要服务 Fast Voice 当前轮回应，不单独进入 Slow System，也不写长期 Story Memory。**

例如模型可以自行决定：

- 放慢语速；
- 减少追问；
- 避免突然切题；
- 使用更合适的共情表达；
- 给用户更多停顿空间。

只有当情绪状态会**显著改变采访策略**时，才允许产生一个弱提示：

```json
{
  "affect_hint": {
    "label": "明显低落且犹豫",
    "confidence": 0.82
  }
}
```

硬规则：

- affect_hint 不是事实；
- 不进入 Story Summary；
- 不进入长期 Agent Memory；
- 不参与人物 / 时间 / 地点事实判断；
- 不做心理诊断；
- 低置信度时不输出。

## 8. 2B Judge 的新定位

原 v1.5：

```text
每轮 Transcript Final
→ 固定 2B Judge
→ 判断是否 Search
```

v1.6：

```text
默认候选：
Step-Audio Tool Trigger

备用 / 对照：
2B Judge
```

独立 Judge 暂时保留为：

1. **Benchmark 对照组**；
2. Step-Audio-mini Tool Trigger 不稳定时的 fallback；
3. 未来需要 transcript-only 路径时的兼容方案；
4. 调试 Tool Trigger Precision / Recall 的参考基线。

在完成真实评测前，不删除 Judge 相关设计和测试资产。

## 9. Step-Audio-mini Tool Trigger Eval

最终是否移除 Judge，不依据“模型支持 Tool Calling”本身，而依据真实采访数据。

至少评测：

### 9.1 Trigger Precision

不需要历史资料时，是否误触发 Slow System。

重点负例：

- 普通寒暄；
- 用户继续描述当前故事；
- 当前 Context 已足够；
- 情绪变化但不需要历史事实；
- 简单追问即可继续。

### 9.2 Trigger Recall

确实需要历史资料时，是否主动调用 Tool。

重点正例：

- “我以前跟你说过……”；
- 老人物重新出现；
- 时间可能冲突；
- Story 跳跃；
- 用户询问过去说过什么；
- 当前上下文不足以确认人物关系；
- 年代背景可能有助于唤起记忆。

### 9.3 Query Quality

Tool 参数里的 query 是否：

- 指向真实信息需求；
- 不包含臆测事实；
- 足够短；
- 足够具体；
- 可以被 Retriever 使用。

### 9.4 End-to-End

记录：

- Tool trigger rate；
- unnecessary trigger rate；
- missed trigger rate；
- Tool parameter validity；
- Slow Path P50 / P95；
- Tool timeout rate；
- Result usefulness；
- Tool Result 回灌后下一问质量。

只有 mini 在真实采访 Eval 中达到可接受水平，才正式删除默认 2B Judge。

## 10. HOLD、Timeout 与恢复

Backend 是 HOLD 的唯一控制者。

建议：

```text
TOOL_HOLD_DEADLINE
≈ 5~6 秒
```

规则：

- Tool Call 发出后当前 Step-Audio Run 已结束；
- Backend 在 Deadline 内等待 Slow Agent；
- 成功则回灌 Context Hint；
- 超时则返回显式 timeout / no-context result；
- Step-Audio 必须继续采访；
- Slow System 失败不能结束 Realtime Session；
- Late Result 不得直接污染已经推进的话题。

Late Result 只有通过 Stale Protection 后才能考虑用于后续轮次。

## 11. Stale Protection

至少携带：

```text
slow_run_id
session_id
based_on_turn_id
context_version
expires_after_turn
```

Backend Adapter 不允许 Step-Audio 自行提供或覆盖：

- owner scope；
- story scope；
- authorization；
- internal resource id；
- deadline；
- stale policy。

## 12. Speculative Retrieval 的调整

v1.5 的“每轮 Judge + speculative embedding”不再作为默认必选方案。

v1.6 优先顺序：

```text
Step-Audio 未触发 Tool
→ 不启动完整 Slow Path

Step-Audio 触发 Tool
→ Backend 启动 Slow Path
→ Classic Retrieval
→ Context Hint
```

未来如果真实 Benchmark 证明 Retrieval 延迟仍不足，可以重新启用：

- 每轮低成本 Query Embedding；
- candidate recall 预取；
- Tool Trigger 后复用已完成 candidates。

但这是性能优化，不是架构前提。

原则：

> **先验证最简单的 Tool-triggered Slow Path，再决定是否引入投机计算。**

## 13. Realtime 数据边界

Fast Voice：

- 当前 Session；
- 当前采访 Prompt；
- Story Agent Memory 的必要短上下文；
- Tool 描述；
- 当前音频及语义；
- Slow System 返回的短 Context Hint。

Slow System：

- Story Agent Memory；
- Classic Retrieval；
- 时代背景库；
- 最近必要轮次；
- Step-Audio Tool Query。

Offline / Closeout：

- 完整 Transcript；
- Story Summary；
- Agent Memory 更新；
- Agentic Retrieval（需要时）；
- Completion / Generation。

## 14. 长期 Memory 写入边界

Realtime Slow System 仍然**不写长期 Story Memory**。

```text
FAST SYSTEM
  当前怎么自然聊

REALTIME SLOW SYSTEM
  当前轮需要什么历史帮助

CLOSEOUT AGENT
  本次访谈结束后长期应该记住什么

OFFLINE DEEP SEARCH
  复杂跨 Session / Story 证据搜索
```

永久 Story Agent Memory 仍由 Interview Closeout 统一维护。

## 15. 最低验收测试

Phase 3 A+B 自动 Gate G0–G8 已覆盖真实 Tool/HOLD/Resume、Retriever recall、并发隔离、延迟预算和最终状态；以下项目继续作为回归、边界或后续模型评测要求：

1. **No-Tool Test**：普通采访轮不应固定进入 Slow System；
2. **Tool Trigger Positive Test**：明确历史引用能触发 get_interview_context；
3. **Tool Trigger Negative Test**：当前上下文足够时不误触发；
4. **Tool Argument Test**：query 合法、短、可检索；
5. **Tool Hold Test**：Tool Call 后 Fast Voice 不继续生成，Backend 进入 HOLD；
6. **Tool Resume Test**：结果回灌后 Step-Audio 能在同一 Session 继续回答；
7. **Tool Timeout Test**：超过 5~6 秒仍能恢复采访；
8. **Slow Failure Test**：Slow Agent / Retriever 失败不终止 Session；
9. **Stale Drop Test**：Late Result 不污染新话题；
10. **Scope Test**：Step-Audio 无法越过 Backend 指定 owner / story scope；
11. **Affect Boundary Test**：情绪提示不得写入 Story Memory；
12. **Judge A/B Test**：Step-Audio Trigger 与独立 2B Judge 做 Precision / Recall 对照；
13. **Mini Eval Test**：Step-Audio-2-mini 在真实采访语料上的 Trigger、Query、Latency 达标后才允许移除 Judge。

## 16. 当前版本边界

当前 Phase 2B 不因此扩展范围。

以下仍为 **Future / Deferred**：

- 人工真实语音体验验收；
- Era Context Search；
- Step-Audio-mini Tool Trigger Eval；
- Realtime 2B Judge A/B；
- Agentic Retrieval 的 Offline 深检索。

当前只冻结接口和责任边界，避免未来开发时重新设计 Realtime 主链路。

## 17. v1.6 最终原则

```text
Step-Audio
= Fast Voice + 第一触发判断

Tool Call
= 当前模型生成暂停点

Backend Tool Adapter
= 权限 / Scope / HOLD / Deadline / Stale Protection

Slow Agent
= 只在被触发后做历史与背景推理

Classic Retrieval
= Realtime Evidence

Context Hint
= 回灌给 Step-Audio 的最小信息

2B Judge
= 暂留的 Benchmark / Fallback，不再默认必经

Closeout Agent
= 长期 Memory Owner
```

目标：

> **能由正在对话的 Voice Model 做出的判断，不额外增加一次模型调用；真正需要历史信息时，才支付 Slow Path 成本。**

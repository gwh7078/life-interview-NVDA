# Realtime

> 当前 Realtime / Coach / 检索 真相源，更新于 2026-09-27。

## 1. Provider

| 配置 | 当前定位 | 执行后端 | 触发方式 |
|---|---|---|---|
| `stepaudio2_mini` | **默认正式 Realtime** | StepFun Cloud | `supervisor_auto` |
| `stepaudio3_quality` | 正式可选 | StepFun Cloud | `voice_tool` |
| `stepfun` | Mini 兼容别名 | StepFun Cloud | `supervisor_auto` |
| `modelbest` | Experimental | ModelBest MiniCPM-o Realtime | provider-specific |
| `qwen` | 兼容 adapter | DashScope | provider-specific |

Spark 部署配置 通过 `STEPAUDIO2_EXECUTION=local` 将 Mini 路由到 本地适配器 / 桥接层。Step-Audio-2-mini 已在 DGX Spark GB10 / ARM64 完成本地真人全链验证，产品层 Provider 协议 保持不变。

## 2. Mini：Fast Voice + interview-coach Skill

Mini 默认不再依赖旧 Independent Memory 路线。实时慢系统现正式定义为 `interview-coach` Skill；为了满足语音低延迟预算，它由产品自建的 实时运行时 执行，不经过通用 OpenClaw / NemoClaw Runtime。

### Story Create / Story Continue / Contributor

```text
User final
   ↓
采访教练判断 (Qwen3-8B)
   ├─ action=none
   │    → Mini 正常回答
   │
   └─ guide / correct / retrieval needed
        ↓
   Story Continue only:
      ├─ Personal Memory 检索
      └─ 时代背景检索
        ↓
   Coach Resolve
        ↓
   bounded Coach Packet
        ↓
   response.create instructions
        ↓
   Mini 回答
```

Story Create 与 Contributor 可以使用 Gate 纠偏，但不能请求 个人记忆 / 时代背景检索。

### Onboarding

Onboarding 优先保证连续对话：

```text
User final
  ├─> 立即 request Mini response
  └─> 异步无检索 Coach
        ↓
      packet ready?
        ↓
      缓存 ≤30s
        ↓
      只给下一回合 Mini 使用一次
```

如果用户已经开始下一次发言、Session 变化、context version 不匹配或过期，Packet 丢弃。

## 3. 时限

```text
判断阶段上限              2,000 ms
Coach total max       6,000 ms
旧慢系统时限  5,000 ms
Era search internal   1,000 ms
```

Mini 的 6 秒总时限 从用户 final transcript 起算，覆盖 Gate、按需 检索 和 Resolve。

原则：

- Coach 失败不让 Voice 失败；
- 超时不把迟到结果塞进以后回合；
- 单路 检索 失败时，另一条有效 evidence 仍可继续；
- 请求了检索但所有请求路径都不可用/失败时 失败放行；
- 无检索且 Gate 已有有效方向时不做无意义 Resolve。

## 4. Personal Memory

只允许 Story Continue 使用。

证据范围：

- owner；
- current story；
- subject；
- 用户 Q+A；
- bounded Top-K。

Retriever Answer 才是个人事实候选；Question 只用于语境。Raw Retriever Result 不直接注入 Voice，也不直接写 Story Memory。

## 5. Era Context

Era 与 Personal Memory 是两个独立维度。

触发要求：

- 当前问题确实受时代背景影响；
- 有可靠窄年份范围；
- 只在 Story Continue；
- 不默认搜整个 1970–2020。

示例：国企改革、下岗潮、恢复高考、住房商品化、大学扩招、SARS、加入 WTO、金融危机、互联网/移动互联网普及等，只有在能改善下一问时才检索。

Era 输出只允许形成中性 `background_hint`，不能断言用户亲历了公共事件。

代码与数据链已完成；默认模板 `NEMO_ERA_CONTEXT_ENABLED=false`，启用状态由环境决定。

## 6. StepAudio 3：Voice Tool 路线

StepAudio 3 不加载 Mini Coach。

```text
Voice decides tool need
→ 工具调用
→ HOLD
→ Current Story 检索
→ interview.context_hint
→ Tool Result
→ Resume
```

该路线仍使用 实时上下文智能体 / 工具结果 生命周期。不要把它与 Mini 的 Qwen3-8B 判断 / 生成指导 合并成同一架构描述。

## 7. Context 注入

Mini Coach Packet：

- 短；
- 一次性；
- 不暴露内部字段；
- 不复制大量 Transcript；
- 不让 Coach 直接向用户作答。

StepAudio 3 Tool Result 同样必须 bounded，并遵守 turn / context version / stale protection。

## 8. 隐私边界

- Contributor 不检索主人公私密历史；
- Era Context 与 私有访谈原文 使用独立 collection；
- 默认 diagnostics 不保存对话正文；
- 技术观测只暴露 allowlisted 指标，不展示 raw session/story/call id 或用户内容。

## 9. 最终验收状态

- Spark 配置 的 Step-Audio-2-mini Realtime 已完成 DGX Spark 本地真人验证；
- 连续语音、追问与打断体验实际运行流畅；
- Realtime + Coach + NeMo Retriever 可在断网条件下协同运行；
- Era Context 仍按 Gate 判断和索引命中按需参与，不会每轮强制检索。

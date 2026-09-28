# Current State

> 更新：2026-09-27  
> 作用：回答“当前 main 到底实现了什么”。任何历史设计与本文冲突时，以当前代码、`.env.example` 和本文为准。

## 1. 产品主链

当前 Web 产品已经具备：

- Demo Phone Auth；
- Onboarding / 人生地图；
- Life Stage CRUD；
- Story Create / Story Continue；
- 第三者分享与 Contributor Interview；
- Transcript 持久化；
- Closeout；
- Story Summary / Story Agent Memory；
- Completion / Gaps；
- Story Generation / Document Version；
- Book 组织与 PDF 路径。

四种 Interview 场景仍分别处理：`onboarding`、`story_create`、`story_continue`、`external_contributor`。

当前产品仍在做真实语音人工测试，尤其是小模型的指令遵循、追问质量、开场/下一问连续性和打断体验；自动化通过不等同于完整真人体验通过。

## 2. Realtime Voice

### 默认

`.env.example` 当前默认：

```text
STORY_INTERVIEW_PROVIDER=stepaudio2_mini
STEPFUN_REALTIME_MODEL=step-audio-2-mini
REALTIME_MEMORY_TRIGGER=supervisor_auto  # Profile 默认值
```

Mac 默认的 Step-Audio-2-mini 仍通过 StepFun Cloud 执行。Spark Deployment Profile 已配置同一 Provider ID 经 Local Adapter/Bridge 执行；GB10 / ARM64 runtime compatibility 仍需 DGX Spark 真机验证，不得写成已在 Spark 稳定运行。

### 其他 Profile

- `stepaudio3_quality`：正式可选 Profile，StepFun Cloud；
- `stepfun`：Mini 的兼容别名；
- `modelbest` / MiniCPM-o-4.5-Realtime：Experimental；
- Qwen Realtime adapter 仍存在，但不是当前默认路线。

## 3. Mini Realtime Coach

Mini 默认 `supervisor_auto`，Coach 模型为 `qwen3-8b`，使用独立 OpenAI-compatible 配置。该能力现正式定义为 `interview-coach` Skill，由产品自建的低延迟 Realtime Runtime 执行，而不是经过 OpenClaw / NemoClaw。

### Onboarding

```text
User final
  ├─> Mini 立即回复
  └─> Coach 异步 sidecar（不检索）
        └─ 如在下一次用户发言前形成有效指导
           → 最多缓存 30 秒
           → 只注入紧接着的一次 Mini 回复
```

Coach 不允许阻塞 Onboarding 当前轮。

### Story Create / Contributor

先跑 Coach Gate，但不允许 Personal Memory / Era Retrieval。普通轮次 `action=none` 时不增加无意义指导。

### Story Continue

```text
User final
   ↓
Qwen3-8B Gate
   ├─ retrieve_memory ?
   └─ retrieve_era ?
        ↓
两路按需并行
   ├─ Current Story Memory Retrieval
   └─ Era Context Retrieval
        ↓
Coach Resolve（需要证据时）
        ↓
Coach Packet
        ↓
当前 Mini response.create instructions
```

关键约束：

- Gate 硬上限：2,000 ms；
- Coach 总 Deadline：6,000 ms；
- Memory 与 Era 独立判断，可同时触发；
- Memory 只允许 owner + Current Story + subject 范围的 Q+A evidence；
- Era 只允许公共背景，不能变成用户事实；
- Contributor 不读取主人公私密 Transcript；
- failure / timeout / stale 均 fail-open，不阻塞 Voice；
- 迟到结果默认不跨回合使用，Onboarding 的下一回合短期 Coach Packet 是唯一特殊路径。

## 4. StepAudio 3 Slow Path

StepAudio 3 使用 `voice_tool` 路线，不加载 Mini Coach。

它保留现有：

```text
Voice Tool Call
→ Current Story Retrieval
→ interview.context_hint
→ Tool Result
→ Resume
```

该路径与 Mini Coach 必须分开描述，不能再统称为“Independent Memory”。

## 5. Retriever / Era Context

### Personal Memory

NeMo Retriever 已有真实 Client、Indexer、Current Story Recall 与测试。SQLite 仍是 Source of Truth，Retriever 是可重建派生索引。

`.env.example` 当前：

```text
NEMO_RETRIEVER_ENABLED=true
NEMO_RETRIEVER_COLLECTION=life-interview-transcripts
```

### Era Context

代码已具备：

- 独立 Era Dataset；
- 独立 public collection；
- dataset build / validate；
- index / retry；
- benchmark；
- Era Client / validation；
- Realtime Coach Story Continue 接入。

默认模板当前仍为：

```text
NEMO_ERA_CONTEXT_ENABLED=false
```

因此正确表述是：**能力已实现并接线，但默认环境模板未开启该索引。** 不能再写成 Future，也不能写成所有环境已经启用。

## 6. Agent Runtime

Task Registry 当前包含：

- `onboarding.closeout`
- `interview.closeout`
  - `story_create`
  - `story_continue`
  - `contributor`
- `interview.context_hint`
- `story.completion`
- `story.generation`

当前正式 Skill family：

- onboarding-closeout
- interview-closeout
- interview-observer
- interview-coach
- story-completion
- story-generation

`story-context-inspector` 是历史 Smoke / 诊断用途，不应计为当前产品 Skill。

`.env.example` 当前默认：

```text
AI_TASK_RUNTIME=direct
```

NemoClaw / OpenClaw Agent Adapter 已实现并有真实 Smoke/E2E 证据，但不能描述成 Web 默认运行时。

## 7. NVIDIA 状态

已完成/已有实现：

- NemoClaw / OpenShell / OpenClaw 本机运行链；
- NeMo Retriever 本机服务与 MCP；
- NAT Evaluation / Profiler 配置；
- Agent Adapter / Contract / Skill；
- Realtime 技术观测；
- Era Context 数据与 Benchmark 工具。

尚未完成：

- DGX Spark 实机最终接入；
- Step-Audio-2-mini 在 Spark 上的目标本地 Realtime 后端；
- Spark 上完整资源占用、P50/P95、并发 Benchmark；
- 最终比赛打包与视频。

## 8. 当前不应再使用的说法

以下表述已经过时：

- “Doubao 是当前 Realtime”；
- “StepAudio 3 是默认 Realtime”；
- “每轮固定 Qwen3.5-2B Judge”；
- “Realtime 当前不 Agent/Coach 化”；
- “Retriever 尚未正式产品集成”；
- “Era Context 仍是 Future”；
- “Mini 使用 Independent Memory → interview.context_hint Agent”；
- “Phase 2B Agent Runtime Integration 仍 In Progress”。

如代码再次变化，应优先修改本文，而不是再新增一个平行的 Current 版本。

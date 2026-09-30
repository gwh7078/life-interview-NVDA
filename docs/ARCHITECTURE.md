# Architecture

> 当前整体架构，更新于 2026-09-28。
> 实时语音细节见 [REALTIME.md](REALTIME.md)，智能体细节见 [AGENT_RUNTIME.md](AGENT_RUNTIME.md)。

## 1. 核心原则

人生采访局不追求“所有东西都 Agent 化”。

```text
Agent / Model = Reasoning Authority
后端           = 执行权威
SQLite        = 业务真相源
Retriever     = Rebuildable Derived Index
```

固定业务流程由 后端决定；语义理解、判断、整理、写作交给模型。智能体输出是候选结果，最终落库仍经过 后端校验 / 事务 / 幂等。

## 2. 系统结构

```text
Browser
  |
  v
Node 后端
├─ Auth / API / WebSocket
├─ Interview Session
├─ Story / Life Stage / Share / Book
├─ Context Builder
├─ Validator / Applier
├─ SQLite
├─ 实时语音
│  ├─ Provider Adapter
│  ├─ Mini 采访教练
│  ├─ 慢系统上下文 / 工具调用循环
│  └─ Observability
├─ Agent Task Port
│  ├─ 直接模型运行时
│  └─ NemoClawAgentTaskAdapter
└─ Retrieval
   ├─ Private Transcript Index
   └─ Public Era Context Index
```

## 3. 后端与智能体边界

后端保留：

- Auth / owner scope；
- Session 生命周期；
- Story / Life Stage / Share / Document / Book；
- SQLite / Repository；
- Transaction / Idempotency；
- resource version / stale protection；
- 结构校验；
- 证据校验；
- 业务规则应用；
- 固定 Task 路由。

模型 / Agent 负责：

- Transcript 语义理解；
- Closeout 提案；
- Memory 更新建议；
- Completion / gaps；
- Story Generation；
- 实时采访教练判断 / 生成指导；
- 必要的 Context Hint。

## 4. 实时语音是独立低延迟子系统

实时语音不走统一“总控智能体”。

Mini 当前默认：

```text
Voice Model
 + Qwen3-8B Coach
 + 按需检索当前 Story
 + conditional Era Retrieval
```

StepAudio 3 当前保留 语音工具 → 上下文提示 路线。

两条路径共享证据边界与后端生命周期，但执行协议不同。

## 5. 智能体任务运行时

会后 Task 通过稳定 Contract 进入 `AgentTaskPort`。

```text
Product Context
→ AgentTaskRequest
→ AgentTaskPort
   ├─ Direct Model
   └─ NemoClawAgentTaskAdapter
→ 结构化候选结果
→ Validator
→ 应用写入
→ SQLite
```

当前环境模板仍默认 Direct；NemoClaw/OpenClaw 是可切换正式运行时，不应与默认配置混为一谈。

## 6. Retrieval

### Private Transcript Index

SQLite Transcript 持久化成功后，Retriever 可以异步建立可重建索引。

实时记忆 只能在严格 scope 下访问：

```text
owner
+ 当前 Story
+ subject
+ Q+A evidence
```

### Public Era Context

时代背景使用独立 collection，不与用户 Transcript 混存。

```text
narrow year window
+ semantic query
→ public background candidates
→ bounded evidence
→ 生成采访指导
```

Era Evidence 只能影响采访方向，不能进入用户事实链。

## 7. Observability

Observability 是 side channel，不编排业务：

- 实时语音轨迹；
- SSE Tech Observer；
- Competition panel；
- Agent timing；
- NAT Eval / Profiler。

技术观测失败不得影响用户采访。

## 8. DGX Spark 运行时边界

Spark 的 文本、采访教练、StepAudio 与 Retriever 运行时 由操作者准备和运行；应用通过配置的标准接口 接入：

```text
Text / Agent  : http://127.0.0.1:8000/v1
Mini 采访教练    : http://127.0.0.1:8001/v1
StepAudio     : ws://127.0.0.1:8092/realtime
Retriever     : REST / MCP 127.0.0.1:7670
VectorDB      : Retriever 运行时内部依赖，不是应用接口
```

操作者在仓库外安装并 onboard NemoClaw，准备好可用的 OpenClaw Agent 和指定 sandbox；这整体作为一个 由操作者管理的 NemoClaw/OpenClaw 智能体运行时。Life Interview setup 检查该 运行时已就绪并运行 后，复用已有 文本 vLLM 的 `/v1/models` 模型清单配置 推理路由，并配置正式会后 智能体 Skills。`interview-coach` Skill 继续由产品低延迟 实时运行时 执行 Qwen3-8B，不经 OpenClaw。Retriever 只通过 Service `:7670` 接入，应用不得直接访问 VectorDB。

macOS 开发 Profile 仍可使用 Step-Audio-2-mini / 非比赛主链。比赛 Spark Profile 已完成 GB10 真机全本地验证：文本、采访教练、StepAudio、Retriever、NemoClaw / OpenClaw 与应用主链均在本地协同运行，支持断网使用，真人连续语音与操作流畅。

## 9. 不再采用的架构

已被取代：

- 每轮固定 Qwen3.5-2B 评审模型；
- Independent Memory 作为 Mini 主慢系统；
- 不接 Retriever、只靠长上下文记忆；
- “Realtime 当前不 Agent 化”；
- 为比赛增加无业务意义的总控 Agent；
- 让 Agent 直接修改 SQLite。

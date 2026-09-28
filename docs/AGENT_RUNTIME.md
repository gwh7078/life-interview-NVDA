# Agent Runtime

> 当前 Agent Task / Skill / Runtime 真相源，更新于 2026-09-28。

## 1. Task Registry

当前正式 Task：

```text
onboarding.closeout

interview.closeout
├─ story_create
├─ story_continue
└─ contributor

interview.context_hint

story.completion

story.generation
```

固定业务入口由 Backend 决定，不增加总控 Agent 重新判断已知路由。

## 2. Skill 与执行 Runtime

当前正式产品 Skill：

- `onboarding-closeout`
- `interview-closeout`
- `interview-observer`
- `interview-coach`
- `story-completion`
- `story-generation`

Life Interview setup 将项目正式 Skill 定义同步到 operator-managed NemoClaw/OpenClaw Agent Runtime。Skills 的安装不改变各产品任务的执行 Runtime：会后 Agent Tasks 由 OpenClaw 执行；Mini `interview-coach` 仍由产品低延迟 Realtime Runtime 执行。

`story-context-inspector` 属于早期 Smoke / 诊断，不计入当前产品能力。

## 3. Runtime

`AgentTaskPort` 支持：

```text
Direct Model Runtime
NemoClaw / OpenClaw Agent Runtime
Stub Runtime
```

Mac `.env.example` 当前默认：

```text
AI_TASK_RUNTIME=direct
```

DGX Spark 目标由操作者准备 Text / Agent Model Service，并在仓库外安装、onboard NemoClaw，准备 OpenClaw Agent 与 sandbox。NemoClaw/OpenClaw Agent Runtime 是一项 operator-managed prerequisite；本仓库将 AgentTask Contract 接到已就绪的指定 sandbox（默认名称 `my-assistant`），不在 Host 上另装 OpenClaw。

NemoClaw/OpenClaw Agent Runtime 由操作者在仓库外按 [NVIDIA 官方 installer](https://www.nvidia.com/nemoclaw.sh) 与 [`nemoclaw onboard`](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart) 准备，并确保指定 sandbox ready/running、OpenClaw 可用。Life Interview setup 只检查 readiness，再把现有 `http://localhost:8000/v1` Text endpoint 和 served model 配置给 OpenClaw，并安装应用 Agent/Skills/policy；不安装、onboard 或启停 Agent Runtime。已有 vLLM 的官方说明见[此处](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)。

## 4. Contract

Agent 输入和输出必须稳定结构化：

```text
Context Builder
→ AgentTaskRequest
→ Runtime
→ Proposal
→ Schema Validation
→ Evidence Validation
→ Domain Validation
→ Apply
```

Agent 不能直接写业务 SQLite。

Reasoning 可以重试；Apply 必须保持幂等和事务边界。

## 5. Tool / Script

固定上下文由 Backend 预取，不让 Agent 为“搬数据”产生额外 Tool Round Trip。

只有运行过程中才能判断是否需要的增量信息才允许 Tool / Script。

当前 Story Continue Closeout 可使用受限 `memory-search` script capability。

## 6. interview.context_hint 与 Mini Coach

`interview.context_hint` 是专用 Realtime Context Agent Task：

- agent id：`realtime-context`；
- thinking：off；
- max attempts：1；
- timeout：4,800 ms；
- no script capability；
- no format/validation repair。

它主要服务 StepAudio 3 的 Voice Tool Slow Path。

**Step-Audio-2-mini 的 `supervisor_auto` Coach 不调用该 Agent，也不经过 OpenClaw。** 产品低延迟 Realtime Runtime 使用 Qwen3-8B 执行 `interview-coach` Skill 的 Gate / Retrieval / Resolve，遵守 2s Gate 与 6s 总 Deadline；失败、超时或 stale 结果不得阻塞当前 Voice。

## 7. Model Profile 与 endpoint

Task Definition 当前按职责映射：

- reasoning；
- reasoning-fast；
- realtime-context；
- writing。

Mac Agent / 文本任务通过 Bailian `qwen3.6-35b-a3b` 配置。Spark 部署目标由操作者运行 OpenAI-compatible Text Service：`nvidia/Qwen3.6-35B-A3B-NVFP4`，默认 `http://127.0.0.1:8000/v1`；NemoClaw 复用 `/v1/models` 实际返回的模型 ID。Mini Coach 单独使用 `Qwen3-8B`，默认 `http://127.0.0.1:8001/v1`。两套 endpoint 分开配置，不能将 Coach 路由到 OpenClaw。

Spark 基础 `verify.sh` 使用有界的产品 acceptance smoke，不运行全量 `npm test` 或 NAT。StepAudio 的具体 Runtime / ARM64 路径仍为 **NOT VERIFIED ON DGX SPARK / ARM64**。

## 8. NAT

NeMo Agent Toolkit 用于：

- Evaluation；
- Regression；
- Profiler；
- Trace / Trajectory；
- Benchmark。

NAT 是比赛 / 应用评测证据面，不接管 `AgentTaskPort`，也不编排产品流程。DGX Spark 上的 NAT、Agent、Coach、Realtime、Retriever 与应用全链路均 **NOT TESTED ON DGX SPARK**，直到真机报告保存可复现结果。

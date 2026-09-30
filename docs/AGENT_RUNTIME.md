# 智能体运行时

> 当前 智能体任务 / Skill / 运行时 真相源，更新于 2026-09-29。

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

固定业务入口由 后端 决定，不增加总控 Agent 重新判断已知路由。

### 1.1 Interview Scenario 与 Skill mode

产品层的 Interview Scenario 与 Skill 内部 mode 是两层概念：

```text
Product Interview Scenarios
├─ onboarding
├─ story_create
├─ story_continue
└─ external_contributor
        ↓
后端 / 任务路由
        ↓
Skill + Skill-local mode
```

- `interview-coach` 支持四种产品 Interview Scenario，并按场景应用不同的实时约束。
- `interview-closeout` 有三个 Skill-local mode：`story_create`、`story_continue`、`contributor`。三者共享 closeout 安全规则，但分别加载不同 reference、Evidence Search 权限和输出 Contract。
- `interview-observer` 是单任务 `interview.context_hint`，无内部 mode 分支。
- `onboarding-closeout` 是单任务 `onboarding.closeout`，无内部 mode 分支。
- `story-completion` 是单任务 `story.completion`，无内部 mode 分支。
- `story-generation` 有 `initial` / `revision` 两个 Skill-local mode。

Mode 是项目运行时 / 任务路由概念，不写成 Agent Skills frontmatter 数组字段。

## 2. Skill 与执行运行时

当前正式产品 Skill：

- `onboarding-closeout`
- `interview-closeout`
- `interview-observer`
- `interview-coach`
- `story-completion`
- `story-generation`

Life Interview setup 将项目正式 Skill 定义同步到 operator-managed NemoClaw/OpenClaw 智能体运行时。Skills 的安装不改变各产品任务的执行 运行时：会后 智能体任务 由 OpenClaw 执行；Mini `interview-coach` 仍由产品低延迟 实时运行时 执行。

`story-context-inspector` 属于早期 Smoke / 诊断，不计入当前产品能力。

## 3. 运行时

`AgentTaskPort` 支持：

```text
直接模型运行时
NemoClaw / OpenClaw 智能体运行时
桩运行时
```

Mac `.env.example` 当前默认：

```text
AI_TASK_RUNTIME=direct
```

DGX Spark 目标由操作者准备 Text / Agent Model Service，并在仓库外安装、onboard NemoClaw，准备 OpenClaw Agent 与 sandbox。NemoClaw/OpenClaw 智能体运行时 是一项 由操作者管理的前置条件；本仓库将 AgentTask Contract 接到已就绪的指定 sandbox（默认名称 `my-assistant`），不在 Host 上另装 OpenClaw。

NemoClaw/OpenClaw 智能体运行时 由操作者在仓库外按 [NVIDIA 官方 installer](https://www.nvidia.com/nemoclaw.sh) 与 [`nemoclaw onboard`](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart) 准备，并确保指定 沙箱已就绪并运行、OpenClaw 可用。Life Interview setup 只检查 就绪状态，再把现有 `http://localhost:8000/v1` 文本接口 和 实际服务模型 配置给 OpenClaw，并安装应用 Agent/Skills/policy；不安装、onboard 或启停 智能体运行时。已有 vLLM 的官方说明见[此处](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)。

## 4. Contract

Agent 输入和输出必须稳定结构化：

```text
上下文构建
→ AgentTaskRequest
→ 运行时
→ 候选结果
→ 结构校验
→ 证据校验
→ 业务规则校验
→ 应用写入
```

Agent 不能直接写业务 SQLite。

推理 可以重试；应用写入 必须保持幂等和事务边界。

## 5. 工具 / 脚本

固定上下文由 后端 预取，不让 Agent 为“搬数据”产生额外 工具往返调用。只有当前上下文不足、存在未解冲突或确需比较多个来源时，Task 才使用共享只读 `evidence-search`；不得为重载已有 Transcript、Memory、Summary、Profile、Life Stage 或文档而检索。

Task Definition 为每个 Skill 限定可请求的 来源类型。后端 持有并校验 owner、resource / Story、Contributor lane、凭证、endpoint、查询与结果边界及 来源信息；Agent 只给短 query 和允许范围内的来源类型，其他可选搜索参数也受 后端 限制。结果是不可信的补充证据，不能覆盖主人公当前明确纠正，也不能绕过现有 Schema、Evidence、Domain、版本或 stale 校验。

当前策略映射见 [Skill / Script Mapping](03-agent/SKILL_SCRIPT_MAPPING_v1.0.md)。Task Definition、后端 route、Evidence Search service / gateway、四个 tool-enabled Skill scripts、各 Task 授权上下文和 Observer 后端 prefetch 已接入共享路径；NemoClaw / OpenClaw Skill activation、工具调用 与完整 Agent Task 链路已在 DGX Spark 本地验收。

## 6. interview.context_hint 与 Mini Coach

`interview.context_hint` 是专用 Realtime Context Agent Task：

- agent id：`realtime-context`；
- thinking：off；
- max attempts：1；
- timeout：4,800 ms；
- Agent 无 Script / Tool capability；固定上下文不足、冲突未解或需比较历史来源时，后端 才异步经共享 Evidence Search 预取 subject-only、owner / current-Story scoped Transcript 证据，供此单次推理使用；
- 不执行格式 / 校验修复。

它主要服务 StepAudio 3 的 Voice Tool Slow Path。

**Step-Audio-2-mini 的 `supervisor_auto` Coach 不调用该 Agent，也不经过 OpenClaw。** 产品低延迟 实时运行时 使用 Qwen3-8B 执行 `interview-coach` Skill 的 判断 / 检索 / 生成指导，遵守 2s Gate 与 6s 总 总时限；失败、超时或 stale 结果不得阻塞当前 Voice。

## 7. 模型配置与接口

Task Definition 当前按职责映射：

- reasoning；
- reasoning-fast；
- realtime-context；
- writing。

DGX Spark 使用本地 OpenAI-compatible Text Service：`nvidia/Qwen3.6-35B-A3B-NVFP4`，默认 `http://127.0.0.1:8000/v1`；NemoClaw 复用 `/v1/models` 实际返回的模型 ID。Mini Coach 单独使用本地 `Qwen3-8B`，默认 `http://127.0.0.1:8001/v1`。两套 endpoint 分开配置，Coach 不经过 OpenClaw。

Spark 基础 `verify.sh` 使用有界的产品 验收冒烟测试，不运行全量 `npm test` 或 NAT。Step-Audio-2-mini 的 ARM64 / DGX Spark 本地 运行时 已完成真人全链验证。

## 8. NAT

NeMo Agent Toolkit 用于：

- Evaluation；
- Regression；
- 性能分析；
- Trace / Trajectory；
- 基准评测。

NAT 是比赛 / 应用评测证据面，不接管 `AgentTaskPort`，也不编排产品流程。DGX Spark 上 Agent、Coach、Realtime、Retriever、NemoClaw / OpenClaw 与应用全链路已完成全本地真人验证，支持断网运行。

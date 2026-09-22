# NeMo Agent Toolkit 开发参考资料索引 v1.0

> Status: **Reference / Pre-implementation**
>
> Date: 2026-09-22
>
> Scope: 为 `life-interview-NVDA` 后续接入 NVIDIA NeMo Agent Toolkit（NAT）提供开发 AI 可直接阅读的官方资料入口与项目边界。
>
> 重要说明：本文档是**开发参考资料**，不代表 NAT、NeMo Relay、ATIF 或 Phoenix 已在项目中落地。

## 1. 项目中的目标定位

当前项目继续保持真实 Agent Runtime：

```text
Backend
-> AgentTaskPort
-> NemoClawAgentTaskAdapter
-> AgentTaskExecutor
-> NemoClaw / OpenShell
-> OpenClaw Agent + Skills
-> Model
```

NAT 的第一阶段定位：

```text
Evaluation
Regression Test
Profiler
Trace / Trajectory
Benchmark
```

不让 NAT 接管当前业务 Adapter，不让 NAT 成为产品请求必经链路。

职责边界：

```text
NemoClaw
-> Runtime / Sandbox

OpenClaw
-> Agent / Skills

现有 AgentTaskAdapter
-> Backend 与 Agent Runtime 接口

NeMo Agent Toolkit
-> Eval / Regression / Profiler

NeMo Relay
-> Runtime Observability

ATIF
-> Agent Trajectory

Phoenix
-> Trace Visualization
```

---

## 2. NAT 官方总入口【必读】

### NeMo Agent Toolkit GitHub

https://github.com/NVIDIA/NeMo-Agent-Toolkit

用途：

- 查看当前稳定版本；
- 查看安装方式；
- 查看 Evaluation / Profiling / Observability 能力；
- 查看官方 examples；
- 确认 Public Plugin API。

开发 AI 不应根据旧版 AIQ / NAT 资料猜测接口，应优先以当前官方仓库和当前安装版本为准。

---

## 3. 安装与依赖【必读】

### Installation Guide

https://github.com/NVIDIA/NeMo-Agent-Toolkit/blob/develop/docs/source/get-started/installation.md

重点：

- Python 版本要求；
- macOS / Linux 支持情况；
- `nvidia-nat`；
- Eval / Profiler / OpenTelemetry / Phoenix 可选依赖；
- `uv` 环境管理。

项目约束：

- NAT 使用独立 Python 环境；
- 不加入 Node 产品 Runtime dependency；
- 优先 Python 3.12；
- 建议目录：`nvidia/nat/.venv`；
- 不修改系统 Python。

---

## 4. Public Plugin API【必读】

### NAT Public Plugin API

https://github.com/NVIDIA/NeMo-Agent-Toolkit/blob/develop/docs/source/extend/plugin-api.md

这是实现 Life Interview NAT Workflow / Adapter / Evaluator 时最重要的开发资料。

优先使用官方 Public Plugin API，例如：

```text
nat.plugin_api
```

重点关注：

```text
register_function
FunctionBaseConfig
FunctionInfo
Builder

register_evaluator
EvaluatorBaseConfig
EvaluatorInfo
EvalBuilder
```

禁止：

- 复制 NAT 内部实现；
- import 未承诺稳定的 private/internal API；
- fork NAT 作为默认方案；
- 修改 NVIDIA NAT 源码来适配本项目。

---

## 5. Custom Evaluator【P0 必读】

### Adding a Custom Evaluator

https://github.com/NVIDIA/NeMo-Agent-Toolkit/blob/develop/docs/source/extend/custom-components/custom-evaluator.md

项目第一阶段应优先使用确定性 Evaluator，而不是大量使用 LLM-as-a-Judge。

重点研究：

```text
register_evaluator
EvaluatorBaseConfig
EvaluatorInfo
EvalInputItem
EvalOutputItem
```

适合封装的项目指标：

```text
runtime_success
schema_valid
backend_validation
attempt_count
repair_count
format_repair_used
latency_ms
tool_call_count
script_call_count
```

以及业务规则：

```text
事实纠正
不确定性保留
第三者证据等级
Generation unsupported fact / hallucination
```

---

## 6. Profiler【P0 必读】

### NAT Profiler API

https://docs.nvidia.com/nemo/agent-toolkit/latest/api/nat/plugins/profiler/profile_runner/index.html

### NVIDIA Agent Blueprint Profiling 示例

https://docs.nvidia.com/aiq-blueprint/latest/profiling/index.html

用于研究：

- workflow runtime；
- latency；
- throughput；
- P90 / P95 / P99；
- token / LLM metrics；
- bottleneck analysis。

当前项目已有：

```text
promptBuildMs
commandMs
openclawMs
hostOverheadMs
parseMs
totalMs
promptBytes
stdoutBytes
stderrBytes
```

第一阶段不要删除现有 Runtime Timing JSONL。

推荐关系：

```text
NAT Profiler
-> 看整体 Workflow / Eval 性能

现有 Runtime Timing
-> 看 NemoClaw / OpenClaw 内部执行阶段
```

等 NAT 覆盖能力经过真实验证后，再决定是否减少重复指标。

---

## 7. OpenClaw Agent Adapter【最高优先级参考】

### NAT Experimental OpenClaw Agent Adapter

https://github.com/NVIDIA/NeMo-Agent-Toolkit/blob/develop/examples/experimental/openclaw_agent_adapter/README.md

这是与本项目当前架构最接近的 NVIDIA 官方样例。

参考架构：

```text
NAT
-> OpenClaw workflow adapter
-> OpenClaw
-> NeMo Relay plugin
-> ATIF / OpenInference
-> Phoenix
```

关键架构原则：

```text
NAT owns workflow/evaluation lifecycle.
OpenClaw owns agent execution.
```

这与本项目希望保持的职责边界一致。

### 重要限制

该示例目前位于：

```text
examples/experimental/
```

并主要基于 OpenClaw Gateway。

而本项目已验证真实链路是：

```text
NemoClaw
-> sandbox exec
-> openclaw agent --local
```

因此：

- 可参考设计；
- 不允许为了套官方示例绕过 NemoClaw；
- 不允许直接把生产 Runtime 改成 Gateway-only；
- NAT 第一阶段必须评测当前真实 NemoClaw 主链。

---

## 8. NeMo Relay + OpenClaw【NAT-2 必读】

### NeMo Relay OpenClaw Plugin

https://github.com/NVIDIA/NeMo-Relay/blob/main/integrations/openclaw/README.md

用于后续更细粒度的 Agent Runtime Observability。

重点关注其是否能捕获：

```text
Agent lifecycle
LLM call
Tool call
Tool result
```

并转换为：

```text
ATIF
OpenTelemetry
OpenInference
```

隐私要求：

- 默认不要记录真实生产 Transcript；
- 不将 token / credential / API key 写入 Trace；
- Tool arguments / results 必须有裁剪和脱敏策略；
- 原始轨迹默认不提交 Git。

---

## 9. ATIF / Agent Trajectory【NAT-2 必读】

### ATIF 官方文档

https://docs.nvidia.com/nemo/relay/dev/configure-plugins/observability/atif

ATIF 用于标准化 Agent 轨迹，例如：

```text
User Step
Agent Step
Tool Call
Observation
Model metadata
Token / cost metadata
Agent / subagent lineage
```

适合：

- 离线 Eval；
- Agent Debug；
- 轨迹分析；
- 比赛技术展示。

但 ATIF 不是业务 Source of Truth。

业务真相继续由：

```text
SQLite
Transcript
agent_runs
Backend Validator
```

负责。

---

## 10. Observability 基础概念【参考】

### NeMo Relay Observability

https://docs.nvidia.com/nemo/relay/configure-plugins/observability/about

开发 AI 应区分：

```text
ATOF
-> Runtime 原始事件

ATIF
-> 标准 Agent Trajectory

OpenTelemetry / OpenInference
-> Trace / Span 输出
```

在本项目中的建议关系：

```text
ATIF
-> Eval / Agent 行为分析

OpenInference
-> Phoenix / Trace UI

agent_runs
-> 产品业务审计
```

不要把三者合并为同一层。

---

## 11. Phoenix【可选，NAT-2】

Phoenix 仅作为开发、调试、比赛展示的可选 Trace UI。

目标用途：

```text
Agent timeline
Model spans
Tool spans
Latency distribution
Error diagnosis
```

硬要求：

```text
没有 Phoenix
-> 产品正常运行

没有 Phoenix
-> NAT Eval 仍可以运行
```

Phoenix 不得成为产品运行依赖。

---

## 12. 开发 AI 推荐阅读顺序

### NAT-1：真实 Runtime Eval

优先阅读：

```text
1. Installation Guide
2. Public Plugin API
3. Custom Evaluator
4. Experimental OpenClaw Agent Adapter
5. Profiler
```

目标：

```text
NAT
-> 调用现有 AgentTaskPort
-> NemoClaw
-> OpenClaw
-> Model
-> Backend Validation
-> NAT Eval
```

### NAT-2：细粒度 Observability

再阅读：

```text
6. NeMo Relay OpenClaw Plugin
7. ATIF
8. Relay Observability
9. Phoenix
```

---

## 13. 当前暂时不用研究的 NAT 能力

当前比赛主线暂不投入时间：

```text
NAT LangChain
NAT CrewAI
NAT LlamaIndex
MCP Agent 构建
A2A
Fine-tuning
RL
Config Optimizer
Dynamo
Agent Performance Primitives
NAT Memory
复杂 Guardrails
```

除非后续产品架构明确需要。

---

## 14. 与当前项目的硬边界

开发 AI 必须牢记：

```text
NAT != Agent Runtime
NAT != NemoClaw
NAT != OpenClaw
NAT != 业务 Adapter
```

第一阶段：

```text
现有业务请求
Backend
-> AgentTaskAdapter
-> NemoClaw
-> OpenClaw
-> Model

测试 / 评测
NAT
-> 包装或调用现有真实 Agent 链路
-> Eval / Profiler / Regression
```

禁止：

1. 为接 NAT 重写 `NemoClawAgentTaskExecutor`；
2. 让 NAT 成为生产请求必经链路；
3. 删除 `agent_runs`；
4. 删除现有 Runtime Timing；
5. 为官方 OpenClaw 示例绕开 NemoClaw；
6. 用 NAT Agent 替换 OpenClaw；
7. 把真实用户 Transcript 放进公开 Eval Dataset；
8. 把 ATIF raw trace、Phoenix DB、Token、API Key 提交 Git。

---

## 15. 当前项目相关代码阅读入口

NAT 开发前还应阅读：

```text
README.md

docs/02-architecture/
ARCHITECTURE_v2.3_agent-execution-efficiency.md

docs/03-agent/
AGENT_EXECUTION_POLICY_v1.0.md

docs/03-agent/contracts/
AGENT_TASK_CONTRACTS_v1.0.md

docs/05-development/phases/
PHASE_2B_C_PRODUCT_RUNTIME_INTEGRATION_v1.0.md

docs/07-reports/testing/
PHASE2B_C_REAL_AGENT_E2E_REPORT_v1.0.md

docs/04-nvidia/
README.md
MODEL_SELECTION_v1.0.md

agent/runtime/
nemoclaw-task-executor.ts

agent/tracing/
agent-run-repository.ts

scripts/
agent-phase2b-real-e2e.ts
```

---

## 16. 版本真实性原则

正式开发时必须记录实际安装版本：

```text
Python
NeMo Agent Toolkit
NemoClaw
OpenClaw
Node
Provider
Model
```

不要把 `develop` 分支示例自动视为当前稳定版 API。

尤其：

```text
OpenClaw Agent Adapter
```

当前属于 experimental 示例，应作为参考设计，而不是稳定接口承诺。

---

## 17. 后续目标技术栈

完成后理想职责：

```text
NemoClaw
-> Agent Runtime / Sandbox

OpenClaw
-> Agent + Skills

NeMo Agent Toolkit
-> Agent Eval / Regression / Profiler

NeMo Relay
-> Runtime Observability

ATIF / OpenInference
-> Agent Trajectory / Trace

NeMo Retriever
-> Memory Retrieval

Nemotron Embed / Rerank
-> Retrieval Models
```

每一项在比赛材料中都必须明确区分：

- Implemented
- Validated
- Current Development
- Planned / Future

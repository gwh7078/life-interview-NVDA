# NVIDIA / DGX Spark

> 当前 NVIDIA 集成状态，更新于 2026-09-27。

## 1. 已进入工程实现

### NemoClaw / OpenShell / OpenClaw

Mac 开发环境已经建立 NemoClaw sandbox `my-assistant`，Agent Runtime 通过受限 Adapter / Skill / Tool 边界运行。

已存在真实 Smoke / E2E 报告，但这些报告属于历史证据，不等于当前所有路径都默认走 Agent Runtime。

### NeMo Retriever

本机当前接口约定：

```text
Retriever Service / REST / MCP  : 127.0.0.1:7670
Internal VectorDB               : 127.0.0.1:7671
```

业务只访问 Retriever Service，不直接写内部 VectorDB。

目前有两类索引：

- private Transcript / Current Story；
- public Era Context。

SQLite 始终是业务 Source of Truth。

### NeMo Agent Toolkit

仓库已有 NAT：

- smoke；
- eval；
- profiler；
- unit tests；
- observability adapter。

NAT 是评测层，不替换 NemoClaw / OpenClaw 产品 Runtime。

## 2. 当前模型执行

### Realtime

- 默认：Step-Audio-2-mini / StepFun Cloud；
- 可选：StepAudio 3 Quality / StepFun Cloud；
- MiniCPM-o-4.5-Realtime：Experimental。

### Text / Agent

当前 Mac 模板使用 Bailian OpenAI-compatible `qwen3.6-35b-a3b`。

这只是当前开发执行后端，不是最终 DGX Spark 模型结论。

## 3. DGX Spark 实机验证状态

Spark Deployment Profile、Base / Runtime / Product 生命周期和 StepAudio Local Adapter/Bridge 工程路径已实现。**GB10 / ARM64 runtime compatibility 待 DGX Spark 真机验证**；当前不能宣称：

- Step-Audio-2-mini 已在 DGX Spark 本地稳定全双工运行；
- Agent 文本模型已全部切到 Spark 本地；
- 已有 Spark P50 / P95；
- 已完成 Spark 资源竞争与并发 Benchmark。

比赛下一阶段需要在真实 Spark 上验证：

```text
model load
→ realtime / text runtime
→ first-token / first-audio latency
→ long-session stability
→ Retriever concurrency
→ Agent concurrency
→ unified memory footprint
→ P50 / P95
```

## 4. 比赛展示原则

NVIDIA 技术栈应该体现为真实系统能力：

- Agent Runtime：NemoClaw / OpenClaw；
- Retrieval：NeMo Retriever；
- Eval / Profiler：NeMo Agent Toolkit；
- Spark：最终本地执行与 Benchmark。

不为了“看起来更 NVIDIA”增加无业务意义的 Agent、Tool 或伪本地路径。

## 5. 当前最重要的技术缺口

1. DGX Spark / GB10 真机兼容性验证；
2. Mini 本地目标后端验证；
3. 文本 Agent 本地模型 Benchmark；
4. Spark 上完整 Realtime + Retriever + Agent 并发；
5. 可复现实验与比赛证据整理。

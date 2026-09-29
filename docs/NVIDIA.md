# NVIDIA / DGX Spark

> 当前 NVIDIA 集成状态，更新于 2026-09-29。DGX Spark 已取得部分真机证据，完整端到端和最终性能仍未通过。

## 1. 项目职责与 Runtime 边界

Spark 的目标部署方式是 **用户准备标准 Runtime，本仓库部署应用并接线**。模型权重、推理进程和 Retriever Service 由操作者按官方方法准备并维护；项目应用从配置读取 endpoint。

| 服务 | 默认地址 | 说明 |
|---|---|---|
| Text / Agent | `http://127.0.0.1:8000/v1` | `nvidia/Qwen3.6-35B-A3B-NVFP4`；以 `/v1/models` 返回的 served ID 为准 |
| Mini Coach | `http://127.0.0.1:8001/v1` | `Qwen3-8B`；由产品低延迟 Realtime Runtime 调用 |
| StepAudio | `ws://127.0.0.1:8092/realtime` | 应用与外部 Realtime bridge 的目标协议地址 |
| NeMo Retriever | REST / MCP `:7670` | 后端 / Agent retrieval 使用的 Service |

SQLite 始终是业务 Source of Truth；Retriever 是可重建索引。Retriever 内部存储由其 Runtime 管理，产品只配置 `NEMO_RETRIEVER_ENABLED`、`NEMO_RETRIEVER_BASE_URL` 与可选 API token。Model Service 与 Retriever Runtime 是独立服务，不由 OpenClaw 代替。

## 2. NemoClaw / OpenClaw

项目把 NemoClaw/OpenClaw 视为一个 operator-managed Agent Runtime；其 sandbox 包含 OpenClaw Agent（默认名 `my-assistant`）。操作者负责官方安装、onboarding 与 sandbox readiness。仓库 setup 只检查 CLI、sandbox status 与 OpenClaw availability，再安装应用 Skills、路由和 policy；不负责 Agent Runtime 安装或生命周期。

首次建立该 Agent Runtime 时，操作者在仓库外使用 [NVIDIA 官方 NemoClaw installer](https://www.nvidia.com/nemoclaw.sh) 和 [`nemoclaw onboard`](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart)。在 Text Runtime 已运行的前提下，选择现有 Local vLLM：NemoClaw 可查询 `http://localhost:8000/v1/models` 并复用已加载模型。模型名称须与服务返回的 served ID 对齐。官方关于已有 vLLM 的说明见 [Set Up vLLM / Use an Existing Server](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)。

OpenClaw 承担 `AgentTaskPort` 的正式会后 Task Runtime。Mini `supervisor_auto` 使用 `interview-coach` Skill，由产品低延迟 Realtime Runtime 调用 Qwen3-8B Gate / Retrieval / Resolve；它不经过 OpenClaw，也不因部署到 Spark 而改成会后 Agent 路径。

## 3. NeMo Retriever 与 NAT

Retriever 的应用接口只有：

```text
REST / MCP Service : 127.0.0.1:7670
```

VectorDB 是 Retriever Runtime 的内部依赖，不是应用 readiness gate 或应用配置项。Web 后端只访问 Retriever Service；Transcript 先持久化到 SQLite，再异步建立派生索引。

NeMo Agent Toolkit（NAT）用于 Evaluation、Regression、Profiler、Trace / Trajectory 和 Benchmark。NAT 是比赛评测与应用质量证据，不接管 `AgentTaskPort`、OpenClaw 或 Mini Coach Runtime。

## 4. 比赛与应用证据

以下内容是工程与比赛证据的组成部分，实际结论以每次保存的运行证据为准：

- **正式 Skills**：展示应用 Task Contract、任务范围和证据边界；会后 Agent Skills 在 NemoClaw / OpenClaw Runtime 执行。
- **NAT**：记录 Agent Evaluation、Profiler、Regression 与轨迹结果。
- **Technical Observer**：呈现应用运行时和 Spark 主机可观测指标，不改变业务决策。
- **Benchmark**：记录 Text、Coach、Realtime、Retriever 与并发场景的输入、延迟、质量、环境和 commit。

配置文件存在、官方支持某模型或 Mac 上运行过，都不能记作 Spark 实测 PASS。

## 5. DGX Spark 状态

当前统一验收状态为 **PARTIAL LOCAL VERIFIED**：

- 2026-09-29 DGX Spark GB10 / ARM64 主机与基础环境：PASS；
- Text、Qwen3-8B Coach、StepAudio Runtime endpoint、NeMo Retriever：现场 PASS；
- Backend/Web、Technical Observer、SQLite：现场 PASS；
- NemoClaw/OpenClaw Agent Task：NOT READY / 未完成；
- 最新 `main` 的完整 E2E、稳定全双工体验与最终 P50 / P95 / 并发：未完成。

历史 full verify 为 13/15 gates PASS，历史 Spark benchmark 也已有测量，但均对应较早版本且不能代表最新 `main`。详细证据见 [DGX Spark 部署现场证据](07-reports/spark-deployment-evidence-2026-09-29.md)。

NVIDIA 的 Qwen3.6 agent-ready model / Spark recipe 是外部 Runtime 准备参考，不是本项目真机验收结果：[DGX Spark vLLM agent-ready models](https://build.nvidia.com/spark/vllm/agent-ready-models)、[Qwen3.6-35B-A3B recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10)。StepAudio 模型资料见 [Step-Audio 2](https://github.com/stepfun-ai/Step-Audio2)；Retriever 官方入口见 [NeMo Retriever](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/)；硬件指南见 [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/)。

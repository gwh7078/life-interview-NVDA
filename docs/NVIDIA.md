# NVIDIA / DGX Spark

> 当前 NVIDIA 集成状态，更新于 2026-09-28。DGX Spark 的兼容性、完整端到端和性能尚无真机证据。

## 1. 项目职责与 Runtime 边界

Spark 的目标部署方式是 **用户准备标准 Runtime，本仓库部署应用并接线**。模型权重、推理进程和 Retriever Service 由操作者按官方方法准备并维护；项目应用从配置读取 endpoint。

| 服务 | 默认地址 | 说明 |
|---|---|---|
| Text / Agent | `http://127.0.0.1:8000/v1` | `nvidia/Qwen3.6-35B-A3B-NVFP4`；以 `/v1/models` 返回的 served ID 为准 |
| Mini Coach | `http://127.0.0.1:8001/v1` | `Qwen3-8B`；由产品低延迟 Realtime Runtime 调用 |
| StepAudio | `ws://127.0.0.1:8092/realtime` | 应用与外部 Realtime bridge 的目标协议地址 |
| NeMo Retriever | REST / MCP `:7670` | 后端 / Agent retrieval 使用的 Service |
| VectorDB | `:7671` | Retriever 内部依赖；产品后端不直接访问或写入 |

SQLite 始终是业务 Source of Truth；Retriever 是可重建索引。Model Service 与 Retriever Runtime 是独立服务，不由 OpenClaw 代替。

## 2. NemoClaw / OpenClaw

项目 AgentTask Runtime 使用 NemoClaw 管理的 OpenClaw sandbox `my-assistant`。正式会后 Agent Skills 安装在该 sandbox 中；不安装第二个 Host OpenClaw。

首次建立 OpenClaw sandbox 时使用 [NVIDIA 官方 NemoClaw installer](https://www.nvidia.com/nemoclaw.sh) 和 [`nemoclaw onboard`](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart)。在 Text Runtime 已运行的前提下，选择现有 Local vLLM：NemoClaw 可查询 `http://localhost:8000/v1/models` 并复用已加载模型。模型名称须与服务返回的 served ID 对齐。官方关于已有 vLLM 的说明见 [Set Up vLLM / Use an Existing Server](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)。

OpenClaw 承担 `AgentTaskPort` 的正式会后 Task Runtime。Mini `supervisor_auto` 使用 `interview-coach` Skill，由产品低延迟 Realtime Runtime 调用 Qwen3-8B Gate / Retrieval / Resolve；它不经过 OpenClaw，也不因部署到 Spark 而改成会后 Agent 路径。

## 3. NeMo Retriever 与 NAT

Retriever 对外接口：

```text
REST / MCP Service : 127.0.0.1:7670
Internal VectorDB  : 127.0.0.1:7671
```

Web 后端只能访问 Retriever Service；不能直接写 VectorDB。Transcript 先持久化到 SQLite，再异步建立派生索引。

NeMo Agent Toolkit（NAT）用于 Evaluation、Regression、Profiler、Trace / Trajectory 和 Benchmark。NAT 是比赛评测与应用质量证据，不接管 `AgentTaskPort`、OpenClaw 或 Mini Coach Runtime。

## 4. 比赛与应用证据

以下内容是工程与比赛证据的组成部分，实际结论以每次保存的运行证据为准：

- **正式 Skills**：展示应用 Task Contract、任务范围和证据边界；会后 Agent Skills 在 NemoClaw / OpenClaw Runtime 执行。
- **NAT**：记录 Agent Evaluation、Profiler、Regression 与轨迹结果。
- **Technical Observer**：呈现应用运行时和 Spark 主机可观测指标，不改变业务决策。
- **Benchmark**：记录 Text、Coach、Realtime、Retriever 与并发场景的输入、延迟、质量、环境和 commit。

配置文件存在、官方支持某模型或 Mac 上运行过，都不能记作 Spark 实测 PASS。

## 5. DGX Spark 状态

当前统一验收状态：

- DGX Spark / GB10 Runtime compatibility：**NOT TESTED ON DGX SPARK**；
- 应用 + Text / Coach / StepAudio / Retriever / NemoClaw 完整 E2E：**NOT TESTED ON DGX SPARK**；
- 首 token / 首音、稳定性、资源占用、并发与 P50 / P95：**NOT TESTED ON DGX SPARK**。

NVIDIA 的 Qwen3.6 agent-ready model / Spark recipe 是外部 Runtime 准备参考，不是本项目真机验收结果：[DGX Spark vLLM agent-ready models](https://build.nvidia.com/spark/vllm/agent-ready-models)、[Qwen3.6-35B-A3B recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10)。StepAudio 模型资料见 [Step-Audio 2](https://github.com/stepfun-ai/Step-Audio2)；Retriever 官方入口见 [NeMo Retriever](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/)；硬件指南见 [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/)。

# DGX Spark Deployment Reference

> 状态：Current deployment boundary and operator reference
> 更新：2026-09-29

## 1. 部署定位

DGX Spark 的标准模型与检索 Runtime 由用户准备和运行；本仓库部署人生采访局应用，并将应用接到这些服务。部署过程保留现有业务 Contract、SQLite Source of Truth、Agent Skill 边界和 Mini Coach 低延迟 Runtime。

本页不把“从裸 Spark 一键安装全部 Runtime”作为目标。`deploy/spark/setup.sh` 与 `start.sh` 只部署 / 启动应用并接线；Text、Coach、StepAudio 与 Retriever 服务须由用户先行准备和维护。

## 2. Runtime 接口

| Role | Model | Default endpoint | Owner / consumer |
|---|---|---|---|
| Text / Agent | `nvidia/Qwen3.6-35B-A3B-NVFP4` | `http://127.0.0.1:8000/v1` | 用户运行 vLLM；OpenClaw 与应用复用 served ID |
| Mini Coach | `Qwen3-8B` | `http://127.0.0.1:8001/v1` | 用户运行；产品低延迟 Realtime Runtime 调用 |
| StepAudio | Step-Audio-2-mini | `ws://127.0.0.1:8092/realtime` | 用户提供符合应用契约的 Realtime Runtime / bridge |
| NeMo Retriever | Transcript / Era collections | REST Service `:7670` | 用户运行；应用只访问 Retriever Service |

操作者预先准备的 NemoClaw/OpenClaw Agent Runtime（默认指定 sandbox 名为 `my-assistant`）承担正式会后 Agent Tasks。Mini `interview-coach` Skill 继续在产品低延迟 Runtime 中执行，不经过 OpenClaw。

## 3. 前置条件

- DGX Spark（ARM64 / aarch64），NVIDIA driver 与 Docker daemon 可用。2026-09-29 已在 GB10 真机完成整套产品全本地验收。
- Git、Python 3.9+、Node.js 24.16+（24.x）或 26.1+、npm；通过 `bash scripts/codex-node.sh` 调用 Node / npm。Python 3 用于应用 setup 与检查，Python 3.12 / uv 是可选 NAT tooling 的额外依赖。
- Text、Coach、StepAudio contract、Retriever endpoint 已在 Spark 上启动。
- Text `:8000/v1/models` 返回真实 served ID；Coach `:8001/v1/models` 与配置一致。
- NemoClaw/OpenClaw Agent Runtime 已由操作者在仓库外完成官方安装与 onboarding；指定 sandbox 已 ready/running 且 OpenClaw 可用。网络访问与凭据由操作者准备，密钥不得提交或写入报告。

## 4. 操作步骤

完整的 Clone → Prepare runtimes → Configure → Setup → Start → Verify 命令见根目录 [README 的 DGX Spark deployment](../../../README.md#dgx-spark-deployment)。

1. Clone 本仓库。
2. 在仓库外依官方资料准备 Text / Coach / StepAudio / Retriever Runtime。
3. 复制 `deploy/spark/env.example` 为忽略文件 `deploy/spark/.env`，按两个 `/v1/models` endpoint 返回的 served ID 配置模型名；Retriever 只需 `NEMO_RETRIEVER_BASE_URL`，不配置其内部存储地址。
4. 在运行仓库 setup 之前，操作者按 NVIDIA 官方方式准备 NemoClaw/OpenClaw Agent Runtime：安装、`nemoclaw onboard`、准备指定 sandbox 并确认 ready/running。
5. 运行 `bash deploy/spark/setup.sh`。它只检查该 Runtime，再配置已有 Text route、realtime-context Agent、Skills 与 policy；不会安装、onboard、启动或停止 NemoClaw/OpenClaw。示例数据默认关闭，只在 `SPARK_SEED_DEMO_DATA=true` 时写入。
6. 运行 `bash deploy/spark/start.sh`。它只启动 Backend、Agent retrieval proxy 和 Technical Observer。
7. 所有服务就绪后在真机运行 `bash deploy/spark/verify.sh`，并保留报告与 gate evidence。

## 5. 比赛 / 应用证据

- **Skills**：说明会后 Agent Task 的应用能力、职责和证据边界。
- **NAT**：记录 Agent Evaluation、Profiler、Regression 和轨迹结果。
- **Technical Observer**：记录真实服务状态及可读取的 Spark 指标。
- **Benchmark**：提供固定输入下的质量、时延、资源和并发结果。

这些证据必须来自实际运行，附带环境和 commit。Harness、endpoint 配置或官方模型 recipe 不能代替 Spark 真机结果。

## 6. 当前验收状态

- 整体状态：**FULL LOCAL VERIFIED / OFFLINE CAPABLE**。
- Text / Agent、Qwen3-8B Coach、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、Backend/Web、Technical Observer、SQLite 均已在 DGX Spark GB10 本地协同运行。
- 断开外部网络后产品主链仍可正常使用。
- 真人连续语音与产品操作表现流畅。
- 现场证据：[DGX Spark 部署验证](../../07-reports/spark-deployment-evidence-2026-09-29.md)。

## 7. 官方参考

- [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/)
- [NVIDIA vLLM agent-ready models for Spark](https://build.nvidia.com/spark/vllm/agent-ready-models)
- [Qwen3.6-35B-A3B GB10 recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10)
- [NemoClaw installer](https://www.nvidia.com/nemoclaw.sh)
- [NemoClaw OpenClaw quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart)
- [NemoClaw existing vLLM setup](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)
- [Step-Audio 2 official repository](https://github.com/stepfun-ai/Step-Audio2)
- [NeMo Retriever getting started](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/)

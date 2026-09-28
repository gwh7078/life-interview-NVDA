# Spark Deployment Agent Brief v1.0

> 更新：2026-09-28
> 业务真相源：`docs/CURRENT_STATE.md`、`docs/REALTIME.md`、`docs/NVIDIA.md`
> 部署定位：用户准备标准 Runtime；本仓库部署应用并接线。

## 1. 目标与范围

在 DGX Spark 上运行人生采访局应用，并使用操作者已部署的模型与检索服务。Runtime 权重、推理服务和 Retriever 由操作者管理；本仓库负责应用配置、Backend、SQLite、Agent Contract / Skills、Technical Observer 和评测接线。

不把裸机 Runtime 安装、模型下载或 Runtime 管理器作为比赛应用的“一键完整安装”目标。当前 Spark compatibility、完整 E2E 与性能均 **NOT TESTED ON DGX SPARK**。

## 2. Runtime Contract

| Runtime | Expected identity | Application endpoint |
|---|---|---|
| Text / Agent | `nvidia/Qwen3.6-35B-A3B-NVFP4` | `http://127.0.0.1:8000/v1` |
| Coach | `Qwen3-8B` | `http://127.0.0.1:8001/v1` |
| StepAudio | Step-Audio-2-mini app contract | `ws://127.0.0.1:8092/realtime` |
| Retriever Service | Transcript / Era retrieval | `http://127.0.0.1:7670` |
| Retriever VectorDB | Retriever internal component | `http://127.0.0.1:7671`；application must not write directly |

Text / Coach model IDs must match each endpoint's `/v1/models`. When `localhost:8000/v1` already serves a model, NemoClaw onboarding can discover and reuse it. Port values are configuration defaults, not proof of connectivity.

## 3. Deployment sequence

Follow the executable sequence in the root [README](../../../README.md#dgx-spark-deployment):

1. Clone the repository on the Spark host.
2. Prepare and start the four operator-managed Runtime endpoints outside the app deployment.
3. Configure ignored `deploy/spark/.env` with addresses, served model IDs, and the isolated SQLite path.
4. Run `bash deploy/spark/setup.sh`. It checks Spark and external endpoints, installs app dependencies, initializes / migrates SQLite, prepares Retriever collections, and wires NemoClaw / OpenClaw.
5. If NemoClaw is missing, setup invokes NVIDIA's official `https://www.nvidia.com/nemoclaw.sh` installer and `nemoclaw onboard`. With vLLM already serving on `localhost:8000`, onboarding reuses its `/v1/models` model. OpenClaw remains inside the NemoClaw sandbox.
6. Setup syncs the project Agent Skills and product policy. Mini Coach still executes through the product low-latency Realtime Runtime.
7. `setup.sh` verifies that the Agent sandbox is running and configured; start the application with `bash deploy/spark/start.sh`. The app start script starts Backend and Technical Observer; external model and Retriever services stay operator-managed.
8. Run `bash deploy/spark/verify.sh` on DGX Spark after all services are running; retain the generated report and evidence.

`interview-coach` is a formal product Skill and may be present in the Agent Skill set. The live Mini Coach path uses Qwen3-8B in the product low-latency Realtime Runtime; it is not routed through NemoClaw / OpenClaw.

## 4. Product and data boundaries

- SQLite is authoritative for Transcript, Session, and Story State.
- Retriever is a rebuildable derived index; persist Transcript first, then index through REST on `:7670`.
- The application never writes directly to VectorDB `:7671`.
- OpenClaw handles formal post-session Agent Tasks via the existing Contract / Tool boundary; it does not own business writes.
- Mini Coach retains `supervisor_auto`, the 2s Gate, 6s overall deadline, stale protection, and fail-open behavior.
- Technical Observer is a side channel and must not affect interview or Agent decisions.
- Secrets and private transcript content must not appear in repository configuration, evidence artifacts, or logs.

## 5. Competition and application evidence

Keep and emphasize these four evidence tracks:

- **Formal Skills** demonstrate application Task roles, inputs, output contracts, and bounded evidence.
- **NAT** supplies repeatable Evaluation, Profiler, Regression, and trace results for Agent behavior.
- **Technical Observer** shows live service and host state, including only metrics the platform can actually report.
- **Benchmark** records fixed inputs, model/runtime identity, environment, commit, quality, latency, resource use, and concurrency.

An official model page, static config, test harness, or Mac result is not a Spark result. A gate becomes PASS only after a real Spark run produces retained evidence.

## 6. Acceptance status

Until a Spark run is performed and its artifacts are reviewed, report all of the following as **NOT TESTED ON DGX SPARK**:

- GB10 / DGX Spark Runtime compatibility;
- StepAudio bridge protocol, streaming, full-duplex, cancel / barge-in, and first-audio behavior;
- Full product E2E across interview, persistence, Coach, Retriever, NemoClaw, and post-session Tasks;
- P50 / P95, stability, memory use, and concurrency.

## 7. Official references

- [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/)
- [NVIDIA Spark vLLM agent-ready models](https://build.nvidia.com/spark/vllm/agent-ready-models)
- [Qwen3.6-35B-A3B GB10 recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10)
- [NemoClaw installer](https://www.nvidia.com/nemoclaw.sh)
- [NemoClaw quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart)
- [NemoClaw existing vLLM endpoint](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)
- [Step-Audio 2](https://github.com/stepfun-ai/Step-Audio2)
- [NeMo Retriever](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/)

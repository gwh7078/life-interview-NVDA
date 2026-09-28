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

Text / Coach model IDs must match each endpoint's `/v1/models`. When `localhost:8000/v1` already serves a model, NemoClaw onboarding can discover and reuse it. Port values are configuration defaults, not proof of connectivity. The Retriever's internal storage is not an application endpoint or deployment gate.

## 3. Deployment sequence

Follow the executable sequence in the root [README](../../../README.md#dgx-spark-deployment):

1. Prepare the DGX Spark host and start Text, Coach, StepAudio, and Retriever endpoints outside the repository.
2. In the same operator-managed layer, install NemoClaw with NVIDIA's official installer, run `nemoclaw onboard`, prepare the OpenClaw sandbox, and confirm it is ready/running.
3. Clone the repository on the Spark host and configure ignored `deploy/spark/.env` with endpoint addresses, served model IDs, the Agent sandbox name, and isolated SQLite path. Keep `TEXT_MODEL_API_KEY` empty.
4. Run `bash deploy/spark/check-env.sh` to check host and external endpoint prerequisites.
5. Run `bash deploy/spark/setup.sh`. It installs app dependencies, migrates SQLite, prepares Retriever collections / Era data, checks the existing Agent Runtime, and configures the existing vLLM route, realtime-context Agent, Formal Skills, and retrieval policy. Demo data remains off unless `SPARK_SEED_DEMO_DATA=true` is explicitly set.
6. Start the application with `bash deploy/spark/start.sh`; it starts Backend, Agent retrieval proxy, and Technical Observer only. Mini Coach remains in the product low-latency Realtime Runtime.
7. Run `bash deploy/spark/verify.sh` on DGX Spark after all services are running; retain the generated report and evidence. Voice G4a/G4b and Agent G7a/G7b are separate gates.

`interview-coach` is a formal product Skill and may be present in the Agent Skill set. The live Mini Coach path uses Qwen3-8B in the product low-latency Realtime Runtime; it is not routed through NemoClaw / OpenClaw.

## 4. Product and data boundaries

- SQLite is authoritative for Transcript, Session, and Story State.
- Retriever is a rebuildable derived index; persist Transcript first, then index through REST on `:7670`.
- Retriever collections and indexes are managed through the REST service; its internal storage remains inside the operator-managed Runtime.
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
- StepAudio Runtime image / backend on DGX Spark ARM64: **NOT VERIFIED ON DGX SPARK / ARM64**;
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

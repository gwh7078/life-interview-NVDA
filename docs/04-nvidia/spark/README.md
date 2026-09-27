# DGX Spark Deployment Reference Hub

> 状态：Current preparation reference  
> 更新：2026-09-27  
> 目标：为 `life-interview-NVDA` 的 DGX Spark 完整移植、一键部署和一天真机验收提供单一入口。

## 1. 这组资料解决什么问题

本目录不是产品架构真相源，也不替代 `docs/CURRENT_STATE.md` / `docs/REALTIME.md` / `docs/NVIDIA.md`。

它只负责：

- 收集 DGX Spark / NVIDIA / StepFun / vLLM-Omni 的当前官方资料；
- 把官方资料映射到本项目的实际部署任务；
- 约束开发 Agent 在租用 Spark 前完成所有可提前完成的工作；
- 给一天真机租用提供固定 Gate、命令入口和证据清单；
- 明确哪些能力已经由官方验证，哪些仍必须在我们的租用 Spark 上实测。

## 2. 阅读顺序

1. [OFFICIAL_REFERENCE_INDEX_v1.0.md](OFFICIAL_REFERENCE_INDEX_v1.0.md)  
   官方资料索引、当前版本快照、已知兼容性和禁止提前假设的事项。

2. [SPARK_DEPLOYMENT_AGENT_BRIEF_v1.0.md](SPARK_DEPLOYMENT_AGENT_BRIEF_v1.0.md)  
   给开发 Agent 的实现约束。目标是提前完成 `deploy/spark/`、配置、Adapter 边界、Smoke、Benchmark 与证据采集。

3. [ONE_DAY_SPARK_RUNBOOK_v1.0.md](ONE_DAY_SPARK_RUNBOOK_v1.0.md)  
   真机到手后的执行顺序。Spark 当天以部署、兼容性修复、Benchmark 和完整验收为主，不现场重新设计架构。

## 3. 当前已确认的 DGX Spark 基线

以 NVIDIA 官方文档 2026-09-27 可见信息为准：

- DGX Spark：Grace Blackwell / GB10；
- CPU：20-core ARM64；
- 内存：128 GB unified memory；
- DGX OS：Ubuntu-based Linux；
- Docker 与 NVIDIA Container Runtime 是官方主路径；
- Founders Edition 当前 release notes：DGX OS 7.5.0、Driver 580.159.03、CUDA 13.0.2、Kernel 6.17；
- GB10 partner system 的版本可能不同，真机必须重新记录；
- NVIDIA 当前 DGX Spark agent-ready vLLM 推荐：`nvidia/Qwen3.6-35B-A3B-NVFP4`；
- NeMo Retriever service image 当前文档明确包含 `linux/arm64` multi-arch manifest；
- Step-Audio-2-mini 已有官方 StepFun vLLM 路径与 vLLM-Omni StepAudio2 pipeline，但公开 vLLM-Omni StepAudio2 资料是 offline / S2ST 能力证据，不等于已经证明 DGX Spark full-duplex Realtime WebSocket。

## 4. 项目最终目标

最终比赛版的 Definition of Done：

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
./deploy/spark/install.sh
```

完成后至少能够：

```text
Web
→ Backend
→ SQLite
→ Step-Audio-2-mini Local Realtime
→ Mini Coach
→ Current Story / Era Retrieval
→ NemoClaw / OpenShell / OpenClaw
→ Local Post-session Agent
→ Closeout / Completion / Generation
→ NAT Eval / Technical Observer
```

并通过：

```bash
./deploy/spark/verify.sh
```

## 5. 资料优先级

发生冲突时按以下优先级处理：

1. 租用 Spark 真机的实际输出；
2. NVIDIA DGX Spark 官方 User Guide / build.nvidia.com Spark Playbook；
3. NVIDIA OpenShell / NeMo Retriever 官方文档；
4. vLLM / vLLM-Omni 官方仓库；
5. StepFun Step-Audio2 官方仓库；
6. 本目录中的项目归纳；
7. 旧历史文档、博客、社区帖子。

任何第三方教程不得覆盖官方约束或真机事实。
